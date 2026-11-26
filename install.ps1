# Install teardrop on Windows. In PowerShell, run:
#
#   irm https://raw.githubusercontent.com/part-avocado/teardrop/main/install.ps1 | iex
#
# Settings, all optional: $env:TEARDROP_VERSION (such as v0.1.0),
# $env:TEARDROP_INSTALL_DIR, $env:TEARDROP_NO_MODIFY_PATH, $env:TEARDROP_NO_SETUP.
# $env:TEARDROP_CLOUD = '1' is for a cloud environment: it sets up Claude Code and
# every other tool found, without asking. Also set $env:TEARDROP_SERVER and
# $env:TEARDROP_KEY as secrets there; hooks then send time straight to the site.
# Rerunning it updates teardrop in place. Works in Windows PowerShell 5.1 and PowerShell 7.

# Everything runs inside this block so `iex` doesn't change the caller's session
# and a download cut off midway runs nothing.
& {
	$ErrorActionPreference = 'Stop'
	$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest's own bar makes downloads far slower in 5.1; Get-File draws its own
	# Windows PowerShell 5.1 may default to TLS 1.0, which GitHub refuses.
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

	# Get-File downloads $uri to $out with a progress bar, and falls back to a
	# plain download if the bar's way of downloading fails for any reason.
	function Get-File($uri, $out, $label) {
		$ProgressPreference = 'Continue'
		try {
			$req = [Net.HttpWebRequest]::Create($uri)
			$req.UserAgent = 'teardrop-installer'
			$res = $req.GetResponse()
			try {
				$total = $res.ContentLength
				$in = $res.GetResponseStream()
				$fs = [IO.File]::Create($out)
				try {
					$buf = New-Object byte[] 81920
					$done = 0
					$last = [DateTime]::MinValue
					while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
						$fs.Write($buf, 0, $n)
						$done += $n
						if ($total -gt 0 -and ([DateTime]::Now - $last).TotalMilliseconds -gt 100) {
							$last = [DateTime]::Now
							Write-Progress -Activity $label -Status ('{0:N1} of {1:N1} MB' -f ($done / 1MB), ($total / 1MB)) -PercentComplete ([int](100 * $done / $total))
						}
					}
				}
				finally { $fs.Dispose(); $in.Dispose() }
			}
			finally { $res.Dispose() }
			Write-Progress -Activity $label -Completed
		}
		catch {
			Write-Progress -Activity $label -Completed
			$ProgressPreference = 'SilentlyContinue'
			Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $out
		}
	}

	$repo = 'part-avocado/teardrop'
	$version = if ($env:TEARDROP_VERSION) { $env:TEARDROP_VERSION } else { 'latest' }
	$base = if ($env:TEARDROP_BASE_URL) { $env:TEARDROP_BASE_URL }
	elseif ($version -eq 'latest') { "https://github.com/$repo/releases/latest/download" }
	else { "https://github.com/$repo/releases/download/$version" }
	$dir = if ($env:TEARDROP_INSTALL_DIR) { $env:TEARDROP_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\teardrop' }

	# 32-bit PowerShell on 64-bit Windows reports x86 here and the real CPU in PROCESSOR_ARCHITEW6432.
	$cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
	$arch = switch ($cpu) {
		'AMD64' { 'amd64' }
		'ARM64' { 'arm64' }
		'x86' { '386' }
		default { Write-Host "teardrop install: $cpu processors are not supported" -ForegroundColor Red; return }
	}
	if (-not $arch) { return }
	$asset = "teardrop_windows_$arch.exe"

	$tmp = Join-Path ([IO.Path]::GetTempPath()) ('teardrop-' + [guid]::NewGuid())
	New-Item -ItemType Directory -Path $tmp | Out-Null
	try {
		Write-Host "Downloading teardrop (windows/$arch)..."
		$file = Join-Path $tmp $asset
		Get-File "$base/$asset" $file 'Downloading teardrop'
		Invoke-WebRequest -UseBasicParsing -Uri "$base/checksums.txt" -OutFile (Join-Path $tmp 'checksums.txt')

		$want = $null
		foreach ($line in Get-Content (Join-Path $tmp 'checksums.txt')) {
			$parts = $line.Trim() -split '\s+'
			if ($parts.Count -ge 2 -and $parts[1].TrimStart('*') -eq $asset) { $want = $parts[0].ToLower() }
		}
		if (-not $want) { throw "checksums.txt has no entry for $asset" }
		$got = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLower()
		if ($got -ne $want) { throw 'the download is corrupted (checksum mismatch). Nothing was installed; try again.' }

		New-Item -ItemType Directory -Force -Path $dir | Out-Null
		$exe = Join-Path $dir 'teardrop.exe'
		# Windows can't overwrite a running .exe but can rename it, so move the old one aside.
		if (Test-Path $exe) {
			Move-Item -Force -Path $exe -Destination "$exe.old"
			Remove-Item -Force "$exe.old" -ErrorAction SilentlyContinue
		}
		Move-Item -Force -Path $file -Destination $exe
	}
	catch {
		Write-Host "teardrop install: $($_.Exception.Message)" -ForegroundColor Red
		return
	}
	finally {
		Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
	}
	$installed = try { & $exe -version } catch { 'teardrop' }
	Write-Host "Installed $installed to $exe"

	$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
	$entries = @($userPath -split ';' | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') })
	$newTerminal = $false
	if ($entries -notcontains $dir.TrimEnd('\')) {
		if ($env:TEARDROP_NO_MODIFY_PATH) {
			Write-Host "$dir is not on your PATH. Add it in Settings > Edit environment variables for your account."
		}
		else {
			[Environment]::SetEnvironmentVariable('Path', (($entries + $dir) -join ';'), 'User')
			Write-Host "Added $dir to your PATH"
			$newTerminal = $true
		}
	}
	if (($env:Path -split ';') -notcontains $dir) { $env:Path = "$env:Path;$dir" }

	if (-not $env:TEARDROP_NO_SETUP) {
		Write-Host ''
		if ($env:TEARDROP_CLOUD -in '1', 'true') {
			# -in ignores case, so True and TRUE count too.
			if (-not $env:TEARDROP_SERVER -or -not $env:TEARDROP_KEY) {
				Write-Host 'Warning: TEARDROP_CLOUD is set, but TEARDROP_SERVER and TEARDROP_KEY are not both set.'
				Write-Host 'Add them as secrets of this environment, or its hooks will send nothing to your site.'
				Write-Host ''
			}
			# Naming claude makes its folder on a fresh container; the second run
			# sets up every other tool found, such as Codex, Copilot, or Cursor.
			& $exe setup -yes claude
			& $exe setup -yes
		}
		else {
			& $exe setup
		}
	}
	if ($newTerminal) {
		Write-Host ''
		Write-Host 'Other open terminals need restarting before `teardrop` works in them.'
	}
}
