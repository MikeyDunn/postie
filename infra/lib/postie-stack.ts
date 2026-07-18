import * as path from 'node:path';
import {
  aws_certificatemanager as acm,
  aws_apigatewayv2 as apigwv2,
  CfnOutput,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  Duration,
  aws_dynamodb as dynamodb,
  aws_events as events,
  aws_lambda_event_sources as eventsources,
  aws_events_targets as eventTargets,
  aws_iam as iam,
  aws_apigatewayv2_integrations as integrations,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_lambda_nodejs as nodejs,
  RemovalPolicy,
  aws_route53 as route53,
  Stack,
  type StackProps,
  aws_s3 as s3,
  aws_sns as sns,
  aws_sns_subscriptions as snsSubs,
  aws_sqs as sqs,
  aws_route53_targets as targets,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

const BOT_TOKEN_PARAM = '/postie/slack/bot-token';
const SIGNING_SECRET_PARAM = '/postie/slack/signing-secret';

export class PostieStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Single table: team config, card dedup locks, daily + lifetime counters.
    const table = new dynamodb.Table(this, 'Table', {
      tableName: 'postie',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY, // low-stakes data; re-run /postie setup after a teardown
    });

    // App-level encryption for the per-team Mailstream API keys.
    const key = new kms.Key(this, 'SecretsKey', {
      alias: 'postie',
      description: 'Postie: encrypts Mailstream API keys stored in DynamoDB',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Rendered card images, served to Mailstream's HTML renderer as public
    // URLs (their artwork fields cap at 100k chars — no inline images).
    // Keys are unguessable UUIDs; objects expire after 180 days.
    const artworkBucket = new s3.Bucket(this, 'Artwork', {
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ expiration: Duration.days(180) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    artworkBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [artworkBucket.arnForObjects('*')],
        principals: [new iam.AnyPrincipal()],
      }),
    );

    const dlq = new sqs.Queue(this, 'JobsDlq', { queueName: 'postie-jobs-dlq' });
    const queue = new sqs.Queue(this, 'Jobs', {
      queueName: 'postie-jobs',
      visibilityTimeout: Duration.seconds(720), // ≥ 6x worker timeout per AWS guidance
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // Failed jobs land in the DLQ after 3 attempts — alarm so they don't die
    // silently. The subscription email must be confirmed once (SNS sends it).
    // Email lives in the gitignored cdk.context.json ("alertEmail"), not the repo.
    const alerts = new sns.Topic(this, 'Alerts', { topicName: 'postie-alerts' });
    const alertEmail =
      (process.env.POSTIE_ALERT_EMAIL as string | undefined) ??
      (this.node.tryGetContext('alertEmail') as string | undefined);
    if (alertEmail) {
      alerts.addSubscription(new snsSubs.EmailSubscription(alertEmail));
    }
    new cloudwatch.Alarm(this, 'DlqAlarm', {
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Postie: jobs are dead-lettering (postcards silently failing)',
    }).addAlarmAction(new cwActions.SnsAction(alerts));

    const ssmRead = new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: 'postie/*' }),
      ],
    });

    const commonEnv = {
      TABLE_NAME: table.tableName,
      KMS_KEY_ID: key.keyId,
      SLACK_BOT_TOKEN_PARAM: BOT_TOKEN_PARAM,
      SLACK_SIGNING_SECRET_PARAM: SIGNING_SECRET_PARAM,
    };

    const entry = (file: string) => path.join(__dirname, '..', '..', 'src', 'lambda', file);

    // Receiver: verify + ack Slack requests within 3s, enqueue the real work.
    const receiver = new nodejs.NodejsFunction(this, 'Receiver', {
      entry: entry('receiver.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(10),
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: { ...commonEnv, QUEUE_URL: queue.queueUrl },
    });
    receiver.addToRolePolicy(ssmRead);
    table.grantReadWriteData(receiver);
    queue.grantSendMessages(receiver);
    key.grantEncrypt(receiver); // modal submissions encrypt the API key

    // Worker: render + send. Wasm/pure-JS image stack (satori, resvg-wasm,
    // jimp) keeps the bundle platform-independent — no docker bundling needed.
    const worker = new nodejs.NodejsFunction(this, 'Worker', {
      entry: entry('worker.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 2048, // CPU scales with memory; rendering is CPU-bound
      timeout: Duration.seconds(120),
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        ...commonEnv,
        // 'live' calls the real Mailstream API with each workspace's own key.
        // Physical mail is still gated account-side (print points + proof
        // approval). Deploy with MAILSTREAM_MODE=stub to sever the API.
        MAILSTREAM_MODE: process.env.MAILSTREAM_MODE ?? 'live',
        FONTS_DIR: '/var/task/assets/fonts',
        ARTWORK_BUCKET: artworkBucket.bucketName,
      },
      bundling: {
        nodeModules: ['satori', '@resvg/resvg-wasm', 'jimp'],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp -r ${inputDir}/assets ${outputDir}/assets`,
          ],
        },
      },
    });
    worker.addEventSource(
      new eventsources.SqsEventSource(queue, { batchSize: 5, reportBatchItemFailures: true }),
    );
    // Delivery tracking: poll open cards' Mailstream status every 4 hours
    // (they ship no tracking webhooks) and post thread updates on change.
    new events.Rule(this, 'TrackingTick', {
      schedule: events.Schedule.rate(Duration.hours(4)),
      targets: [
        new eventTargets.SqsQueue(queue, {
          message: events.RuleTargetInput.fromObject({ type: 'track_all' }),
        }),
      ],
    });
    worker.addToRolePolicy(ssmRead);
    table.grantReadWriteData(worker);
    key.grantDecrypt(worker);
    artworkBucket.grantPut(worker);

    // Custom domain (context in cdk.json: domain + hostedZone). Cert is
    // DNS-validated against the Route53 zone — fully automated, no email.
    const domainName = this.node.tryGetContext('domain') as string | undefined;
    const zoneName = this.node.tryGetContext('hostedZone') as string | undefined;

    let apiDomain: apigwv2.DomainName | undefined;
    let zone: route53.IHostedZone | undefined;
    if (domainName && zoneName) {
      zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: zoneName });
      const certificate = new acm.Certificate(this, 'Certificate', {
        domainName,
        validation: acm.CertificateValidation.fromDns(zone),
      });
      apiDomain = new apigwv2.DomainName(this, 'Domain', { domainName, certificate });
    }

    const api = new apigwv2.HttpApi(this, 'Api', {
      apiName: 'postie',
      ...(apiDomain ? { defaultDomainMapping: { domainName: apiDomain } } : {}),
    });
    api.addRoutes({
      path: '/slack/events',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('SlackIntegration', receiver),
    });
    if (apiDomain && zone && domainName) {
      new route53.ARecord(this, 'DnsRecord', {
        zone,
        recordName: domainName,
        target: route53.RecordTarget.fromAlias(
          new targets.ApiGatewayv2DomainProperties(
            apiDomain.regionalDomainName,
            apiDomain.regionalHostedZoneId,
          ),
        ),
      });
    }

    const publicUrl = domainName ? `https://${domainName}` : api.apiEndpoint;
    new CfnOutput(this, 'SlackRequestUrl', {
      value: `${publicUrl}/slack/events`,
      description: 'Use for Slack event subscriptions, interactivity, and the /postie command',
    });
  }
}
