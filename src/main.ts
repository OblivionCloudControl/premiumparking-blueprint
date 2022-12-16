import {
  App, Stack, StackProps, IAspect, TagManager, ITaggable, Aspects, RemovalPolicy, CfnOutput,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_s3 as s3,
  aws_ecs_patterns as ecsPatterns,
  aws_secretsmanager as secretsmanager,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
} from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Construct, IConstruct } from 'constructs';

type Tags = { [key: string]: string } & {
  'stage': 'dev' | 'staging' | 'prod';
  'project': string;
  'owner': string;
  'map-migrated': string;
};

class ApplyTags implements IAspect {
  #tags: Tags;

  constructor(tags: Tags) {
    this.#tags = tags;
  }

  visit(node: IConstruct) {
    if (TagManager.isTaggable(node)) {
      Object.entries(this.#tags).forEach(([key, value]) => {
        this.applyTag(node, key, value);
      });
    }
  }

  applyTag(resource: ITaggable, key: string, value: string) {
    resource.tags.setTag(
      key,
      value,
    );
  }
}

interface MyAppStackProps extends StackProps {
  vpcName: string;
  containerImage: ecs.ContainerImage;
};
export class MyApp extends Stack {
  constructor(scope: Construct, id: string, props: MyAppStackProps) {
    super(scope, id, props);

    // define resources here...
    const vpc = ec2.Vpc.fromLookup(this, 'vpc', {
      vpcName: props.vpcName,
    });

    // dummy secret
    const secret = new secretsmanager.Secret(this, 'TaskSecret', {
      removalPolicy: RemovalPolicy.DESTROY,
    });
    NagSuppressions.addResourceSuppressions(secret, [
      { id: 'AwsSolutions-SMG4', reason: 'No rotation in this demo' },
    ], true);

    const loadBalancingLoggingBucket = new s3.Bucket(this, 'LoadBalancerLogs', {
      removalPolicy: RemovalPolicy.DESTROY,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS_MANAGED,
      enforceSSL: true,
    });
    NagSuppressions.addResourceSuppressions(loadBalancingLoggingBucket, [
      { id: 'AwsSolutions-S1', reason: 'No server access logs for this access logs bucket' },
    ]);

    const loadBalancedFargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Service', {
      memoryLimitMiB: 1024,
      cpu: 512,
      taskImageOptions: {
        image: props.containerImage,
        secrets: {
          SAMPLE_SECRET: ecs.Secret.fromSecretsManager(secret),
        },
      },
      vpc: vpc,
      taskSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      publicLoadBalancer: true,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
      },
    });
    loadBalancedFargateService.targetGroup.configureHealthCheck({
      path: '/',
    });
    loadBalancedFargateService.loadBalancer.logAccessLogs(loadBalancingLoggingBucket);

    NagSuppressions.addResourceSuppressions(loadBalancedFargateService.loadBalancer, [
      { id: 'AwsSolutions-EC23', reason: 'Allow open security groups' },
    ], true);
    NagSuppressions.addResourceSuppressions(loadBalancedFargateService.cluster, [
      { id: 'AwsSolutions-ECS4', reason: 'No CloudWatch Container Insights in this demo' },
    ]);


    const scalableTarget = loadBalancedFargateService.service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 20,
    });

    scalableTarget.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 50,
    });

    scalableTarget.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 50,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(loadBalancedFargateService.loadBalancer, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });
    NagSuppressions.addResourceSuppressions(distribution, [
      { id: 'AwsSolutions-CFR1', reason: 'No Geo restriction in this demo' },
      { id: 'AwsSolutions-CFR2', reason: 'No WAF in this demo' },
      { id: 'AwsSolutions-CFR3', reason: 'No access logs in this demo' },
      { id: 'AwsSolutions-CFR4', reason: 'Deprecated protols cannot be disabled using the default distribution' },
      { id: 'AwsSolutions-CFR5', reason: 'Plain-text HTTP towards the origin in this demo' },
    ], true);

    new CfnOutput(this, 'ServiceDistributionDomainName', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'ServiceDistributionId', { value: distribution.distributionId });
  }
}

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// Define the app
const app = new App();
new MyApp(app, 'my-app-dev', {
  env: devEnv,
  vpcName: 'landingzone-vpc',
  containerImage: ecs.ContainerImage.fromRegistry('nginx'),
});

// Apply tags
const appAspects = Aspects.of(app);
appAspects.add(new ApplyTags({
  'stage': 'dev',
  'project': 'Premium Parking migration',
  'owner': 'Premium Parking',
  'map-migrated': 'd-server-tbd',
}));
appAspects.add(new AwsSolutionsChecks({ verbose: true }));

app.synth();