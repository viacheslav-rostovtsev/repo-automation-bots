
param (
    [string]$workDir,
    [string]$lang = "nodejs"
)


function New-TemporaryDirectory {
    $parent = [System.IO.Path]::GetTempPath()
    [string] $name = [System.Guid]::NewGuid()
    New-Item -ItemType Directory -Path (Join-Path $parent $name)
}

if (!$workDir) {
    $workDir = New-TemporaryDirectory
}

Write-Host -ForegroundColor Blue "Working in $workDir"

function CloneOrPull-Repo([string]$repo) {
    $name = $repo.split('/')[1]
    if (Test-Path $name) {
        git -C $name pull | Write-Host
    } else {
        gh repo clone $repo | Write-Host
    }
    return (Resolve-Path $name)
}

function Query-Yn([string]$prompt) {
    while ($true) {
        $yn = Read-Host "${prompt} (y/n)"
        if ('y' -eq $yn) {
            return $yn
        } else if ('n' -eq $yn) {
            return $yn
        }
    }
}

function Migrate-Repo([string]$localPath, [string]$sourceRepoPath) {
    # Ask the user to look at sytnh.py and provide the details we need.
    cat "$localPath/synth.py"
    if ('n' -eq (Query-Yn "Wanna migrate?")) {
        return
    }
    $dv = Read-Host "What's the default version?"
    $apiPath = Read-Host "What's the API path in googleapis-gen?"

    $sourceCommitHash = git -C $sourceRepoPath log -1 --format=%H
    echo $sourceCommitHash

    # Create a branch
    git -C $localPath checkout -b owl-bot

    # Update .repo-metadata.json with the default version.
    $metadataPath = "$localPath/.repo-metadata.json"
    $metadata = Get-Content $metadataPath | ConvertFrom-Json -AsHashTable
    $metadata['default_version'] = $dv
    $metadata | ConvertTo-Json | Out-File $metadataPath -Encoding UTF8

    # Write Owlbot config files.
    $yamlPath = "$localPath/.github/.OwlBot.yaml"
    $lockPath = "$localPath/.github/.OwlBot.lock.yaml"
    $yaml = "# Copyright 2021 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the `"License`");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an `"AS IS`" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
docker:
  image: gcr.io/repo-automation-bots/owlbot-nodejs:latest

deep-remove-regex:
  - /owl-bot-staging

deep-copy-regex:
  - source: /${apiPath}/(.*)/.*-nodejs/(.*)
    dest: /owl-bot-staging/`$1/`$2

begin-after-commit-hash: ${sourceCommitHash}
"
    $yaml | Out-File $yamlPath -Encoding UTF8

    $lock = "docker:
  digest: sha256:b317576c0e66d348ab6c1ae50dc43405df37f957b58433c988c1e9ca257ba3d4
  image: gcr.io/repo-automation-bots/owlbot-nodejs:latest  
"
    $lock | Out-File $lockPath -Encoding UTF8

    $cleanExit = $false
    try {

        # Remove obsolete files.
        Remove-Item "${localPath}/synth.metadata"
        while ($true) {
            echo "Edit ${yamlPath} and edit or remove ${localPath}/synth.py before I commit changes."
            Pause

            # Commit changes
            git -C $localPath add -A
            git -C $localPath commit -m "chore: migrate to owl bot"

            echo "Copying code from googleapis-gen..."
            # Run copy-code to simulate a copy from googleapis-gen.
            docker run  --user "$(id -u):$(id -g)" --rm -v "${localPath}:/repo" -w /repo `
                -v "${sourceRepoPath}:/source" `
                gcr.io/repo-automation-bots/owlbot-cli copy-code `
                --source-repo /source `
                --source-repo-commit-hash $sourceCommitHash

            git -C $localPath add -A
            git -C $localpath commit -m "chore: copy files from googleapis-gen ${sourceCommitHash}"

            function Rollback {
                echo "Trying again..."
                git -C $localPath reset --hard HEAD~1
                git -C $localPath reset --soft HEAD~1        
            }

            if ("y" -eq (Query-Yn "Do the copied files look good?")) {
                # And run the post processor.
                # TODO(rennie): change the docker image to repo-automation-bots when it's fixed.
                docker run --user "$(id -u):$(id -g)" --rm -v "${localPath}:/repo" -w /repo `
                    gcr.io/cloud-devrel-kokoro-resources/owlbot-nodejs:latest
                echo "${localPath} is ready for you to inspect and create a pull request."
                if ("y" -eq (Query-Yn "Ready to move on to the next repo?")) {
                    $cleanExit = $true
                    return
                } else {
                    Rollback
                }
            } else {
                Rollback
            }
        }
    } finally {
        if (-not $cleanExit) {
            # Remove these yaml files so we'll start again with this repo
            Remove-Item $yamlPath,$lockPath
        }

    }
}

pushd
try {
    # Clone googleapis-gen and get its most recent commit hash.
    cd $workDir
    $sourceRepoPath = CloneOrPull-Repo googleapis/googleapis-gen
    $currentHash = git -C googleapis-gen log -1 --format=%H

    # Get the list of repos from github.
    $allRepos = gh repo list googleapis --limit 1000
    $matchInfos = $allRepos | Select-String -Pattern "^googleapis/${lang}-[^ \r\n\t]+"
    $repos = $matchInfos.matches.value

    foreach ($repo in $repos) {
        $name = CloneOrPull-Repo $repo
        $owlBotPath = "$name/.github/.OwlBot.yaml"
        if (Test-Path $owlBotPath) {
            Write-Host -ForegroundColor Blue "Skipping $name;  Found $owlBotPath."
        } else {
            Write-Host -ForegroundColor Blue "Migrating $name..."
            Migrate-Repo $name $sourceRepoPath
        }
    }

} finally {
    popd
}