import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Job } from './types';

export interface JobQueue {
  enqueue(job: Job): Promise<void>;
}

export class SqsJobQueue implements JobQueue {
  private sqs = new SQSClient({});
  constructor(private queueUrl: string) {}

  async enqueue(job: Job): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(job) }),
    );
  }
}
