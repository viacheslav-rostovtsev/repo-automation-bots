
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
    return $name
}

function Migrate-Repo([string]$localPath) {
    cat "$localPath/synth.py"
    while ($true) {
        $yn = Read-Host "Wanna migrate? (y/n)"
        if ("y" -eq $yn) {
            break;
        } elseif ("n" -eq $yn) {
            return;
        }
    }
    $dv = Read-Host "What's the default version?"
    git -C $localPath checkout -b owl-bot
    
}

pushd
try {
    # Clone googleapis-gen and get its most recent commit hash.
    cd $workDir
    CloneOrPull-Repo googleapis/googleapis-gen
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
            Migrate-Repo $name
        }
    }

} finally {
    popd
}