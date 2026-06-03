"""
Lambda function to start the Picker EC2 instance.
Triggered by EventBridge Scheduler at 7:45 AM ET daily.

Setup:
  1. Create Lambda function (Python 3.12, 128MB, 10s timeout)
  2. Set environment variable: INSTANCE_ID = i-xxxxxxxxxxxxxxxxx
  3. Attach IAM role with ec2:StartInstances permission
  4. Create EventBridge rule: cron(45 11 ? * MON-SUN *)  (11:45 UTC = 7:45 AM ET)
"""
import os
import boto3


def lambda_handler(event, context):
    instance_id = os.environ["INSTANCE_ID"]
    ec2 = boto3.client("ec2")
    ec2.start_instances(InstanceIds=[instance_id])
    print(f"Started instance {instance_id}")
    return {"statusCode": 200, "body": f"Started {instance_id}"}
