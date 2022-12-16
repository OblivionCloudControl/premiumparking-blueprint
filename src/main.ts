import {
  App, Stack, StackProps, IAspect, TagManager, ITaggable, Aspects,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_ecs_patterns as ecsPatterns,
  aws_secretsmanager as secretsmanager,
  RemovalPolicy,
} from 'aws-cdk-lib';

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

    const cluster = new ecs.Cluster(this, 'FargateCluster', { vpc });
    const loadBalancedFargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Service', {
      cluster,
      memoryLimitMiB: 1024,
      cpu: 512,
      taskImageOptions: {
        image: props.containerImage,
        secrets: {
          SECRET: ecs.Secret.fromSecretsManager(secret),
        },
      },
      taskSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      publicLoadBalancer: true,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
    });
    loadBalancedFargateService.targetGroup.configureHealthCheck({
      path: '/',
    });


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

app.synth();