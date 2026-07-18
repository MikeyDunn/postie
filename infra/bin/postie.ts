#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { PostieStack } from '../lib/postie-stack';

const app = new App();
new PostieStack(app, 'Postie', {
  // Concrete env required for the Route53 hosted-zone lookup.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});
