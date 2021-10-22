'use strict'

class CloudFrontAPIRoute {
  constructor (serverless, options) {
    this.serverless = serverless
    this.options = options
    this.provider = this.serverless.getProvider('aws')
    this.region = this.provider.getRegion()
    this.stage = this.provider.getStage()
    this.sdkProviderParams = {
      credentials: this.provider.getCredentials().credentials,
      region: this.region
    }
    this.stackName = this.provider.naming.getStackName()
    this.apiOriginId = `${this.stackName}-origin`
    this.cloudfront = new this.provider.sdk.CloudFront(this.sdkProviderParams)
    this.cloudformation = new this.provider.sdk.CloudFormation(this.sdkProviderParams)

    this.hooks = {
      'after:deploy:deploy': this.upsertAPIRoute.bind(this),
      'before:remove:remove': this.deleteAPIRoute.bind(this)
    }

    // Parameters
    // Required ones
    this.distributionId = serverless.service.custom.cloudFrontAPIRoute.cloudFrontDistributionID
    this.basePath = `${serverless.service.custom.cloudFrontAPIRoute.basePath}/*`

    // Optional
    this.originConnectionAttempts = 3
    if ('originConnectionAttempts' in serverless.service.custom.cloudFrontAPIRoute) {
      this.originConnectionAttempts = serverless.service.custom.cloudFrontAPIRoute.originConnectionAttempts
    }
    this.originConnectionTimeout = 10
    if ('originConnectionTimeout' in serverless.service.custom.cloudFrontAPIRoute) {
      this.originConnectionTimeout = serverless.service.custom.cloudFrontAPIRoute.originConnectionTimeout
    }
    this.originKeepaliveTimeout = 5
    if ('originKeepaliveTimeout' in serverless.service.custom.cloudFrontAPIRoute) {
      this.originKeepaliveTimeout = serverless.service.custom.cloudFrontAPIRoute.originKeepaliveTimeout
    }
    this.originReadTimeout = 30
    if ('originReadTimeout' in serverless.service.custom.cloudFrontAPIRoute) {
      this.originReadTimeout = serverless.service.custom.cloudFrontAPIRoute.originReadTimeout
    }
    this.minTTL = 1
    if ('minTTL' in serverless.service.custom.cloudFrontAPIRoute) {
      this.minTTL = serverless.service.custom.cloudFrontAPIRoute.minTTL
    }
    this.maxTTL = 31536000
    if ('maxTTL' in serverless.service.custom.cloudFrontAPIRoute) {
      this.maxTTL = serverless.service.custom.cloudFrontAPIRoute.maxTTL
    }
    this.defaultTTL = 86400
    if ('defaultTTL' in serverless.service.custom.cloudFrontAPIRoute) {
      this.defaultTTL = serverless.service.custom.cloudFrontAPIRoute.defaultTTL
    }
  }

  async getApiGatewayUrl () {
    const params = { StackName: this.stackName }
    const result = await this.cloudformation.describeStackResources(params).promise()
    const apiGatewayResource = result.StackResources.find((element) => {
      return element.ResourceType === 'AWS::ApiGateway::RestApi'
    })

    return `${apiGatewayResource.PhysicalResourceId}.execute-api.${this.region}.amazonaws.com`
  }

  async getCloudFrontDistributionConfiguration () {
    const params = {
      Id: this.distributionId
    }

    return await this.cloudfront.getDistributionConfig(params).promise()
  }

  async updateCloudFrontDistributionConfiguration (updatedConfiguration, ifMatchVersion) {
    const params = {
      Id: this.distributionId,
      DistributionConfig: updatedConfiguration,
      IfMatch: ifMatchVersion
    }

    return await this.cloudfront.updateDistribution(params).promise()
  }

  getExistingOrigin (distributionConfig) {
    const existingOrigin = distributionConfig.Origins.Items.find((element) => {
      return element.Id === this.apiOriginId
    })

    return existingOrigin
  }

  getExistingBehavior (distributionConfig) {
    const existingBehavior = distributionConfig.CacheBehaviors.Items.find((element) => {
      return element.TargetOriginId === this.apiOriginId
    })

    return existingBehavior
  }

  getOrigin (apiUrl) {
    return {
      DomainName: apiUrl,
      Id: this.apiOriginId,
      OriginPath: `/${this.stage}`,
      CustomHeaders: {
        Quantity: 0,
        Items: []
      },
      ConnectionAttempts: this.originConnectionAttempts,
      ConnectionTimeout: this.originConnectionTimeout,
      CustomOriginConfig: {
        HTTPPort: 80,
        HTTPSPort: 443,
        OriginProtocolPolicy: 'https-only',
        OriginKeepaliveTimeout: this.originKeepaliveTimeout,
        OriginReadTimeout: this.originReadTimeout,
        OriginSslProtocols: {
          Items: [
            'TLSv1.2',
            'SSLv3'
          ],
          Quantity: 2
        }
      }
    }
  }

  addAPIOrigin (distributionConfig, apiUrl) {
    const updatedConfiguration = distributionConfig

    const apiOrigin = this.getOrigin(apiUrl)
    updatedConfiguration.Origins.Items.push(apiOrigin)
    updatedConfiguration.Origins.Quantity++

    return updatedConfiguration
  }

  getBehavior () {
    return {
      TargetOriginId: this.apiOriginId,
      PathPattern: this.basePath,
      ViewerProtocolPolicy: 'redirect-to-https',
      AllowedMethods: {
        Items: [
          'GET',
          'HEAD',
          'POST',
          'PUT',
          'PATCH',
          'OPTIONS',
          'DELETE'
        ],
        Quantity: 7,
        CachedMethods: {
          Items: [
            'GET',
            'HEAD'
          ],
          Quantity: 2
        }
      },
      SmoothStreaming: false,
      Compress: true,
      MinTTL: this.minTTL,
      MaxTTL: this.maxTTL,
      DefaultTTL: this.defaultTTL,
      ForwardedValues: {
        Cookies: {
          Forward: 'none',
          WhitelistedNames: {
            Quantity: 0,
            Items: []
          }
        },
        QueryString: false,
        Headers: {
          Quantity: 0,
          Items: []
        },
        QueryStringCacheKeys: {
          Quantity: 0,
          Items: []
        }
      },
      LambdaFunctionAssociations: {
        Quantity: 0,
        Items: []
      },
      FunctionAssociations: {
        Quantity: 0,
        Items: []
      },
      FieldLevelEncryptionId: '',
      TrustedSigners: {
        Enabled: false,
        Quantity: 0,
        Items: []
      },
      TrustedKeyGroups: {
        Enabled: false,
        Quantity: 0,
        Items: []
      }
    }
  }

  addAPIBehavior (distributionConfig) {
    const updatedConfiguration = distributionConfig

    const apiBehavior = this.getBehavior()
    updatedConfiguration.CacheBehaviors.Items.push(apiBehavior)
    // Prioritize behaviors with longer path patterns
    updatedConfiguration.CacheBehaviors.Items.sort(function (a, b) {
      if (a.PathPattern.split('/').length() < b.PathPattern.split('/').length()) return -1
      else if (a.PathPattern.split('/').length() > b.PathPattern.split('/').length()) return 1
      else return 0
    })
    updatedConfiguration.CacheBehaviors.Quantity++

    return updatedConfiguration
  }

  checkUpdatedOrigin (existingOrigin, apiUrl) {
    const existingApiUrl = existingOrigin.DomainName
    const existingConnectionAttempts = existingOrigin.ConnectionAttempts
    const existingConnectionTimeout = existingOrigin.ConnectionTimeout
    const existingOriginKeepaliveTimeout = existingOrigin.CustomOriginConfig.OriginKeepaliveTimeout
    const existingOriginReadTimeout = existingOrigin.CustomOriginConfig.OriginReadTimeout

    if (existingApiUrl !== apiUrl) {
      return true
    }
    if (existingConnectionAttempts !== this.originConnectionAttempts) {
      return true
    }
    if (existingConnectionTimeout !== this.originConnectionTimeout) {
      return true
    }
    if (existingOriginKeepaliveTimeout !== this.originKeepaliveTimeout) {
      return true
    }
    if (existingOriginReadTimeout !== this.originReadTimeout) {
      return true
    }
    return false
  }

  checkUpdatedBehavior (existingBehavior) {
    const existingPathPattern = existingBehavior.PathPattern
    const existingMinTTL = existingBehavior.MinTTL
    const existingMaxTTL = existingBehavior.MaxTTL
    const existingDefaultTTL = existingBehavior.DefaultTTL

    if (existingPathPattern !== this.basePath) {
      return true
    }
    if (existingMinTTL !== this.minTTL) {
      return true
    }
    if (existingMaxTTL !== this.maxTTL) {
      return true
    }
    if (existingDefaultTTL !== this.defaultTTL) {
      return true
    }
    return false
  }

  delAPIOrigin (updatedConfiguration, existingOrigin) {
    let index = -1

    for (const [i, element] of updatedConfiguration.Origins.Items.entries()) {
      if (element.Id === existingOrigin.Id) {
        index = i
      }
    }

    if (index > -1) {
      updatedConfiguration.Origins.Items.splice(index, 1)
      updatedConfiguration.Origins.Quantity--
    }

    return updatedConfiguration
  }

  delAPIBehavior (updatedConfiguration, existingBehavior) {
    let index = -1

    for (const [i, element] of updatedConfiguration.CacheBehaviors.Items.entries()) {
      if (element.TargetOriginId === existingBehavior.TargetOriginId) {
        index = i
      }
    }

    if (index > -1) {
      updatedConfiguration.CacheBehaviors.Items.splice(index, 1)
      updatedConfiguration.CacheBehaviors.Quantity--
    }

    return updatedConfiguration
  }

  async upsertAPIRoute () {
    this.serverless.cli.log('-------------------------')
    this.serverless.cli.log('CloudFrontAPIRoute UpSert operation')
    this.serverless.cli.log(` -- Distribution id: ${this.distributionId}`)
    this.serverless.cli.log(` -- Base path: ${this.basePath}`)

    let result = await this.getCloudFrontDistributionConfiguration()
    const apiUrl = await this.getApiGatewayUrl()
    const distributionConfig = result.DistributionConfig
    const ifMatchVersion = result.ETag
    let updatedConfiguration = distributionConfig
    let update = false

    const existingOrigin = this.getExistingOrigin(distributionConfig)
    const existingBehavior = this.getExistingBehavior(distributionConfig)

    this.serverless.cli.log(' -- Checking origin')
    if (existingOrigin === undefined) {
      this.serverless.cli.log(` -- Add origin '${this.apiOriginId}'`)
      updatedConfiguration = this.addAPIOrigin(updatedConfiguration, apiUrl)
      update = true
    } else {
      if (this.checkUpdatedOrigin(existingOrigin, apiUrl)) {
        this.serverless.cli.log(` -- Update origin '${this.apiOriginId}'`)
        updatedConfiguration = this.delAPIOrigin(updatedConfiguration, existingOrigin)
        updatedConfiguration = this.addAPIOrigin(updatedConfiguration, apiUrl)
        update = true
      }
    }

    this.serverless.cli.log(' -- Checking behavior')
    if (existingBehavior === undefined) {
      this.serverless.cli.log(` -- Add behavior '${this.basePath}'`)
      updatedConfiguration = this.addAPIBehavior(updatedConfiguration)
      update = true
    } else {
      if (this.checkUpdatedBehavior(existingBehavior)) {
        this.serverless.cli.log(` -- Update behavior '${this.basePath}'`)
        updatedConfiguration = this.delAPIBehavior(updatedConfiguration, existingBehavior)
        updatedConfiguration = this.addAPIBehavior(updatedConfiguration)
        update = true
      }
    }

    if (update) {
      result = await this.updateCloudFrontDistributionConfiguration(updatedConfiguration, ifMatchVersion)
      const updatedDistribution = result.Distribution
      this.serverless.cli.log(` -- Updating distribution ${updatedDistribution.Id}...`)
    } else {
      this.serverless.cli.log(' -- No updates pending')
    }
    this.serverless.cli.log('-------------------------')
  }

  async deleteAPIRoute () {
    this.serverless.cli.log('-------------------------')
    this.serverless.cli.log('CloudFrontAPIRoute Delete operation')
    this.serverless.cli.log(` -- Distribution id: ${this.distributionId}`)
    this.serverless.cli.log(` -- Base path: ${this.basePath}`)

    let result = await this.getCloudFrontDistributionConfiguration()
    const distributionConfig = result.DistributionConfig
    const ifMatchVersion = result.ETag
    let updatedConfiguration = distributionConfig
    let update = false

    const existingOrigin = this.getExistingOrigin(distributionConfig)
    const existingBehavior = this.getExistingBehavior(distributionConfig)

    this.serverless.cli.log(' -- Checking origin')
    if (existingOrigin !== undefined) {
      this.serverless.cli.log(` -- Delete origin '${this.apiOriginId}'`)
      updatedConfiguration = this.delAPIOrigin(updatedConfiguration, existingOrigin)
      update = true
    }

    this.serverless.cli.log(' -- Checking behavior')
    if (existingBehavior !== undefined) {
      this.serverless.cli.log(` -- Delete behavior '${this.basePath}'`)
      updatedConfiguration = this.delAPIBehavior(updatedConfiguration, existingBehavior)
      update = true
    }

    if (update) {
      result = await this.updateCloudFrontDistributionConfiguration(updatedConfiguration, ifMatchVersion)
      const updatedDistribution = result.Distribution
      this.serverless.cli.log(` -- Updating distribution ${updatedDistribution.Id}...`)
    } else {
      this.serverless.cli.log(' -- No updates pending')
    }
    this.serverless.cli.log('-------------------------')
  }
}

module.exports = CloudFrontAPIRoute