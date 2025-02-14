// Copyright 2019 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// eslint-disable-next-line node/no-extraneous-import
import {Probot} from 'probot';
import {
  ReleasePRFactoryOptions,
  GitHubReleaseFactoryOptions,
  ReleasePR,
  factory,
} from 'release-please';
import {Runner} from './runner';
// eslint-disable-next-line node/no-extraneous-import
import {Octokit} from '@octokit/rest';
// We pull in @octokit/request to crreate an appropriate type for the
// GitHubAPI interface:
// eslint-disable-next-line node/no-extraneous-import
import {request} from '@octokit/request';
import {logger} from 'gcf-utils';
import {
  ReleaseType,
  getReleaserNames,
} from 'release-please/build/src/releasers';
import {Manifest} from 'release-please/build/src/manifest';
type RequestBuilderType = typeof request;
type DefaultFunctionType = RequestBuilderType['defaults'];
type RequestFunctionType = ReturnType<DefaultFunctionType>;

type OctokitType = InstanceType<typeof Octokit>;

interface GitHubAPI {
  graphql: Function;
  request: RequestFunctionType;
}

interface BranchOptions {
  releaseLabels?: string[];
  monorepoTags?: boolean;
  releaseType?: ReleaseType;
  packageName?: string;
  handleGHRelease?: boolean;
  bumpMinorPreMajor?: boolean;
  path?: string;
  changelogPath?: string;
  manifest?: boolean;
  extraFiles?: string[];
}

interface BranchConfiguration extends BranchOptions {
  branch: string;
}

interface ConfigurationOptions extends BranchOptions {
  primaryBranch: string;
  branches?: BranchConfiguration[];
}

const DEFAULT_API_URL = 'https://api.github.com';
const WELL_KNOWN_CONFIGURATION_FILE = 'release-please.yml';
const DEFAULT_CONFIGURATION: ConfigurationOptions = {
  primaryBranch: 'master',
  branches: [],
  manifest: false,
};
const FORCE_RUN_LABEL = 'release-please:force-run';

function releaseTypeFromRepoLanguage(language: string | null): ReleaseType {
  if (language === null) {
    throw Error('repository has no detected language');
  }
  switch (language.toLowerCase()) {
    case 'java':
      return 'java-yoshi';
    case 'typescript':
    case 'javascript':
      return 'node';
    case 'php':
      return 'php-yoshi';
    case 'go':
      return 'go-yoshi';
    default: {
      const releasers = getReleaserNames();
      if (releasers.includes(language.toLowerCase())) {
        return language.toLowerCase() as ReleaseType;
      } else {
        throw Error(`unknown release type: ${language}`);
      }
    }
  }
}

function findBranchConfiguration(
  branch: string,
  config: ConfigurationOptions
): BranchConfiguration | null {
  // look at primaryBranch first
  if (branch === config.primaryBranch) {
    return {
      ...config,
      ...{branch},
    };
  }

  if (!config.branches) {
    return null;
  }

  const found = config.branches.find(branchConfig => {
    return branch === branchConfig.branch;
  });
  if (found) {
    return found;
  }

  return null;
}

// turn a merged release-please release PR into a GitHub release.
async function createGitHubRelease(
  packageName: string,
  repoUrl: string,
  configuration: BranchConfiguration,
  github: GitHubAPI
) {
  const releaseOptions: GitHubReleaseFactoryOptions = {
    label: 'autorelease: pending',
    repoUrl,
    packageName,
    apiUrl: DEFAULT_API_URL,
    octokitAPIs: {
      octokit: (github as {}) as OctokitType,
      graphql: github.graphql,
      request: github.request,
    },
    path: configuration.path,
    changelogPath: configuration.changelogPath ?? 'CHANGELOG.md',
    monorepoTags: configuration.monorepoTags,
    releaseType: configuration.releaseType,
    extraFiles: configuration.extraFiles,
  };
  if (configuration.manifest) {
    const manifest = factory.manifest(releaseOptions);
    await Runner.manifestRelease(manifest);
  } else {
    const ghr = factory.githubRelease(releaseOptions);
    await Runner.releaser(ghr);
  }
}

async function createReleasePR(
  repoName: string,
  repoUrl: string,
  repoLanguage: string | null,
  configuration: BranchConfiguration,
  github: GitHubAPI,
  snapshot?: boolean
): Promise<ReleasePR | Manifest> {
  const releaseType = configuration.releaseType
    ? configuration.releaseType
    : releaseTypeFromRepoLanguage(repoLanguage);
  const packageName = configuration.packageName || repoName;

  const buildOptions: ReleasePRFactoryOptions = {
    defaultBranch: configuration.branch,
    packageName,
    repoUrl,
    apiUrl: DEFAULT_API_URL,
    octokitAPIs: {
      octokit: (github as {}) as OctokitType,
      graphql: github.graphql,
      request: github.request,
    },
    bumpMinorPreMajor: configuration.bumpMinorPreMajor,
    path: configuration.path,
    monorepoTags: configuration.monorepoTags,
    releaseType,
    extraFiles: configuration.extraFiles,
  };
  if (snapshot !== undefined) {
    buildOptions.snapshot = snapshot;
  }
  if (configuration.releaseLabels) {
    buildOptions.label = configuration.releaseLabels.join(',');
  }

  if (configuration.manifest) {
    const manifest = factory.manifest(buildOptions);
    await Runner.manifest(manifest);
    return manifest;
  } else {
    const releasePR = factory.releasePR(buildOptions);
    await Runner.runner(releasePR);
    return releasePR;
  }
}

export = (app: Probot) => {
  app.on('push', async context => {
    const repoUrl = context.payload.repository.full_name;
    const branch = context.payload.ref.replace('refs/heads/', '');
    const repoName = context.payload.repository.name;
    const repoLanguage = context.payload.repository.language;

    const remoteConfiguration: ConfigurationOptions | null = (await context.config(
      WELL_KNOWN_CONFIGURATION_FILE
    )) as ConfigurationOptions | null;

    // If no configuration is specified,
    if (!remoteConfiguration) {
      logger.info(`release-please not configured for (${repoUrl})`);
      return;
    }

    const configuration = {
      ...DEFAULT_CONFIGURATION,
      ...remoteConfiguration,
    };

    const branchConfiguration = findBranchConfiguration(branch, configuration);
    if (!branchConfiguration) {
      logger.info(`Did not find configuration for branch: ${branch}`);
      return;
    }

    logger.info(`push (${repoUrl})`);
    await createReleasePR(
      repoName,
      repoUrl,
      repoLanguage,
      branchConfiguration,
      context.octokit as GitHubAPI,
      undefined
    );

    // release-please can handle creating a release on GitHub, we opt not to do
    // this for our repos that have autorelease enabled.
    if (branchConfiguration.handleGHRelease) {
      logger.info(`handling GitHub release for (${repoUrl})`);
      await createGitHubRelease(
        branchConfiguration.packageName ?? repoName,
        repoUrl,
        branchConfiguration,
        context.octokit as GitHubAPI
      );
    }
  });

  // See: https://github.com/octokit/webhooks.js/issues/277
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.on('schedule.repository' as any, async context => {
    const repoUrl = context.payload.repository.full_name;
    const repoName = context.payload.repository.name;

    const remoteConfiguration = (await context.config(
      WELL_KNOWN_CONFIGURATION_FILE
    )) as ConfigurationOptions | null;

    // If no configuration is specified,
    if (!remoteConfiguration) {
      logger.info(`release-please not configured for (${repoUrl})`);
      return;
    }

    const configuration = {
      ...DEFAULT_CONFIGURATION,
      ...remoteConfiguration,
    };

    logger.info(
      `schedule.repository (${repoUrl}, ${configuration.primaryBranch})`
    );
    const defaultBranchConfiguration = {
      ...configuration,
      ...{branch: configuration.primaryBranch},
    };

    // get the repository language
    const repository = await context.octokit.repos.get(context.repo());
    const repoLanguage = repository.data.language;

    await createReleasePR(
      repoName,
      repoUrl,
      repoLanguage,
      defaultBranchConfiguration,
      context.octokit,
      true
    );

    if (!configuration.branches) {
      return;
    }

    await Promise.all(
      configuration.branches.map(branchConfiguration => {
        logger.info(
          `schedule.repository (${repoUrl}, ${branchConfiguration.branch})`
        );
        return createReleasePR(
          repoName,
          repoUrl,
          repoLanguage,
          branchConfiguration,
          context.octokit,
          true
        );
      })
    );
  });

  app.on('pull_request.labeled', async context => {
    // if missing the label, skip
    if (
      // See: https://github.com/probot/probot/issues/1366
      !context.payload.pull_request.labels.some(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (label: any) => label.name === FORCE_RUN_LABEL
      )
    ) {
      logger.info(
        `ignoring non-force label action (${context.payload.pull_request.labels.join(
          ', '
        )})`
      );
      return;
    }

    const repoUrl = context.payload.repository.full_name;
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    const branch = context.payload.pull_request.base.ref;
    const repoName = context.payload.repository.name;
    const repoLanguage = context.payload.repository.language;

    // remove the label
    await context.octokit.issues.removeLabel({
      name: FORCE_RUN_LABEL,
      issue_number: context.payload.pull_request.number,
      owner,
      repo,
    });

    // check release please config
    const remoteConfiguration = (await context.config(
      WELL_KNOWN_CONFIGURATION_FILE
    )) as ConfigurationOptions | null;

    // If no configuration is specified,
    if (!remoteConfiguration) {
      logger.info(`release-please not configured for (${repoUrl})`);
      return;
    }

    const configuration = {
      ...DEFAULT_CONFIGURATION,
      ...remoteConfiguration,
    };

    const branchConfiguration = findBranchConfiguration(branch, configuration);
    if (!branchConfiguration) {
      logger.info(`Did not find configuration for branch: ${branch}`);
      return;
    }

    logger.info(`pull_request.labeled (${repoUrl})`);
    await createReleasePR(
      repoName,
      repoUrl,
      repoLanguage,
      branchConfiguration,
      context.octokit as GitHubAPI,
      undefined
    );
  });
};
