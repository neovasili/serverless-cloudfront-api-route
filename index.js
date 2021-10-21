'use strict';

class CloudFrontAPIRoute {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider('aws');
    this.region = this.provider.getRegion();
    this.stage = this.provider.getStage();
    this.sdkProviderParams = {
      credentials: this.provider.getCredentials().credentials,
      region: this.region,
    }
    this.stackName = this.provider.naming.getStackName();
    this.apiOriginId = `${this.stackName}-origin`;
    this.cloudfront = new this.provider.sdk.CloudFront(this.sdkProviderParams);
    this.cloudformation = new this.provider.sdk.CloudFormation(this.sdkProviderParams);

    this.hooks = {
      'after:info:info': this.createAPIRoute.bind(this),
    };

    this.distributionId = serverless.service.custom.cloudFrontAPIRoute.cloudFrontDistributionID;
    this.basePath = serverless.service.custom.cloudFrontAPIRoute.basePath;
  }

  async getApiGatewayUrl() {
    const params = { StackName: this.stackName };
    const result = await this.cloudformation.describeStackResources(params).promise();
    const apiGatewayResource = result.StackResources.find((element) => {
      return element.ResourceType === 'AWS::ApiGateway::RestApi';
    });

    return `${apiGatewayResource.PhysicalResourceId}.execute-api.${this.region}.amazonaws.com`;
  }

  async getCloudFrontDistributionConfiguration() {
    const params = {
      Id: this.distributionId,
    };

    return await this.cloudfront.getDistributionConfig(params).promise();
  }

  async updateCloudFrontDistributionConfiguration(updatedConfiguration, ifMatchVersion) {
    const params = {
      Id: this.distributionId,
      DistributionConfig: updatedConfiguration,
      IfMatch: ifMatchVersion,
    };

    return await this.cloudfront.updateDistribution(params).promise();
  }

  alreadyExistsBehavior(distributionConfig) {
    const existingBehavior = distributionConfig.CacheBehaviors.Items.find((element) => {
      return element.TargetOriginId === this.apiOriginId;
    });

    return existingBehavior !== undefined;
  }

  alreadyExistsOrigin(distributionConfig) {
    const existingOrigin = distributionConfig.Origins.Items.find((element) => {
      return element.Id === this.apiOriginId;
    });

    return existingOrigin !== undefined;
  }

  async addAPIOrigin(distributionConfig) {
    let updatedConfiguration = distributionConfig;
    const apiUrl = await this.getApiGatewayUrl();
    this.serverless.cli.log(` -- Service url: ${apiUrl}`);

    const apiOrigin = {
      DomainName: apiUrl,
      Id: this.apiOriginId,
      OriginPath: `/${this.stage}`,
      CustomHeaders: {
        Quantity: 0,
        Items: [],
      },
      ConnectionAttempts: 3,
      ConnectionTimeout: 10,
      CustomOriginConfig: {
        HTTPPort: 80,
        HTTPSPort: 443,
        OriginProtocolPolicy: "https-only",
        OriginKeepaliveTimeout: 5,
        OriginReadTimeout: 30,
        OriginSslProtocols: {
          Items: [
            "TLSv1.2",
            "TLSv1.1",
          ],
          Quantity: 2,
        },
      },
    }
    updatedConfiguration.Origins.Items.push(apiOrigin);
    updatedConfiguration.Origins.Quantity++;

    return updatedConfiguration;
  }

  addAPIBehavior(distributionConfig) {
    let updatedConfiguration = distributionConfig;

    const apiBehavior = {
      TargetOriginId: this.apiOriginId,
      PathPattern: this.basePath,
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: {
        Items: [
          "GET",
          "HEAD",
          "POST",
          "PUT",
          "PATCH",
          "OPTIONS",
          "DELETE",
        ],
        Quantity: 7,
        CachedMethods: {
          Items: [
            "GET",
            "HEAD",
          ],
          Quantity: 2,
        },
      },
      SmoothStreaming: false,
      Compress: true,
      MinTTL: 1,
      MaxTTL: 31536000,
      DefaultTTL: 86400,
      ForwardedValues: {
        Cookies: {
          Forward: "all",
          WhitelistedNames: {
            Quantity: 0,
            Items: [],
          },
        },
        QueryString: true,
        Headers: {
          Quantity: 0,
          Items: [],
        },
        QueryStringCacheKeys: {
          Quantity: 0,
          Items: [],
        },
      },
      LambdaFunctionAssociations: {
        Quantity: 0,
        Items: [],
      },
      FunctionAssociations: {
        Quantity: 0,
        Items: [],
      },
      FieldLevelEncryptionId: "",
    }
    updatedConfiguration.CacheBehaviors.Items.push(apiBehavior);
    updatedConfiguration.CacheBehaviors.Quantity++;

    return updatedConfiguration;
  }

  async createAPIRoute() {
    this.serverless.cli.log("-------------------------");
    this.serverless.cli.log("CloudFrontAPIRoute plugin");
    this.serverless.cli.log(` -- Distribution id: ${this.distributionId}`);
    this.serverless.cli.log(` -- Base path: ${this.basePath}`);
    
    let result = await this.getCloudFrontDistributionConfiguration();
    const distributionConfig = result.DistributionConfig;
    const ifMatchVersion = result.ETag;
    let updatedConfiguration = distributionConfig;
    let update = false;
    
    if (!this.alreadyExistsOrigin(distributionConfig)) {
      updatedConfiguration = await this.addAPIOrigin(updatedConfiguration);
      const origins = updatedConfiguration.Origins.Items;
      origins.forEach(origin => {
        this.serverless.cli.log(` -- Distribution origin: ${origin.Id} - ${origin.DomainName} - ${origin.OriginPath}`);
      });
      update = true;
    }
    
    if (!this.alreadyExistsBehavior(distributionConfig)) {
      updatedConfiguration = this.addAPIBehavior(updatedConfiguration);
      const behaviors = updatedConfiguration.CacheBehaviors.Items;
      behaviors.forEach(behavior => {
        this.serverless.cli.log(` -- Distribution behavior: ${behavior.TargetOriginId} - ${behavior.PathPattern}`);
      });
      update = true;
    }

    if (update) {
      result = await this.updateCloudFrontDistributionConfiguration(updatedConfiguration, ifMatchVersion);
      const updatedDistribution = result.Distribution;
      this.serverless.cli.log(` -- Updated: ${updatedDistribution.Id}`);
    } else {
      this.serverless.cli.log(" -- No updates pending");
    }
  }
}

module.exports = CloudFrontAPIRoute;
