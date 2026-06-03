"""
Lambda function to stop the Picker EC2 instance.
Triggered by EventBridge Scheduler at 8:15 PM ET daily.

Setup:
  1. Create Lambda function (Python 3.12, 128MB, 10s timeout)
  2. Set environment variable: INSTANCE_ID = i-xxxxxxxxxxxxxxxxx
  3. Attach IAM role with ec2:StopInstances permission
  4. Create EventBridge rule: cron(15 0 ? * TUE-MON *)  (00:15+1 UTC = 8:15 PM ET)
"""
import os
import boto3


def lambda_handler(event, context):
    instance_id = os.environ["INSTANCE_ID"]
    ec2 = boto3.client("ec2")
    ec2.stop_instances(InstanceIds=[instance_id])
    print(f"Stopped instance {instance_id}")
    return {"statusCode": 200, "body": f"Stopped {instance_id}"}
