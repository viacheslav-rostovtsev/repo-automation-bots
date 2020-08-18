#!/bin/bash
# Copyright 2020 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# This script ensures that a Cloud Build trigger exists for each non-root
# cloudbuild.yaml file. Each is triggered on a push to master for any file
# changed in the directory containing that cloudbuild.yaml file.

if [[ $# -lt 6 ]]
then
  echo "Usage: $0 <project> <bucket> <functionRegion> <keyRing> <region> <schedulerServiceAccountEmail>"
  exit 1
fi

project=$1
bucket=$2
functionRegion=$3
keyRing=$4
region=$5
schedulerServiceAccountEmail=$6

# propagate substitution variables to deploy triggers
substitions="_BUCKET=${bucket},_FUNCTION_REGION=${functionRegion},_KEY_RING=${KEY_RING},_REGION=${region},_SCHEDULER_SERVICE_ACCOUNT_EMAIL=${schedulerServiceAccountEmail}"

# find all non-root cloudbuild.yaml configs
for config in $(find */ -name 'cloudbuild.yaml')
do
  directory=$(dirname ${config})
  botName=$(dirname ${config} | rev | cut -d/ -f1 | rev)
  triggerName=$(dirname ${config} | sed 's/\//_/g')

  # test to see if the deployment trigger already exists
  gcloud beta builds triggers describe ${triggerName} \
    --project=${project}
  if [[ $? -eq 0 ]]
  then
    # trigger already exists, skip
    continue
  fi

  echo "Syncing trigger for ${botName}"

  # create the trigger
  echo gcloud beta builds trigger create github \
    --project="${project}" \
    --repo-name="repo-automation-bots" \
    --repo-owner="googleapis" \
    --description="Deploy ${botName}" \
    --included-files="${dirname}/*" \
    --name="${triggerName}" \
    --branch-pattern="master" \
    --build-config="${config}" \
    --substitutions="${substitutions}"

  # trigger the first deployment
  echo gcloud beta builds trigger run ${triggerName} \
    --project="${project}"
done