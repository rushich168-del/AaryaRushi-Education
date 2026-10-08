param([ValidateSet('Status','Start','Stop')][string]$Action='Status')
$ErrorActionPreference='Stop'
$clusterPath='C:\KST\.local_pg'
$pgBin='C:\Program Files\PostgreSQL\16\bin'
$expectedSystemId='7684311220310446404'
$logPath=Join-Path ([System.IO.Path]::GetTempPath()) 'ksc-exam-contract-postgres.log'
if ((Resolve-Path -LiteralPath $clusterPath).Path -ne $clusterPath) { throw 'Unexpected cluster path' }
if ((Get-Acl -LiteralPath $clusterPath).Owner -ne 'AARYARUSHI\AARYA RUSHI') { throw 'Unexpected cluster filesystem owner' }
$control=& "$pgBin\pg_controldata.exe" $clusterPath
if ($LASTEXITCODE -ne 0 -or -not ($control -match "Database system identifier:\s+$expectedSystemId$")) { throw 'Unknown cluster identity' }
function Confirm-ConnectedTarget {
 $identity=& "$pgBin\psql.exe" -X -w -h 127.0.0.1 -p 54322 -U postgres -d postgres -At -v ON_ERROR_STOP=1 -c "SELECT current_setting('data_directory') || '|' || system_identifier::text || '|' || host(inet_server_addr()) || '|' || inet_server_port() FROM pg_control_system()"
 if ($LASTEXITCODE -ne 0 -or $identity -ne "C:/KST/.local_pg|$expectedSystemId|127.0.0.1|54322") { throw 'Local SQL identity check failed; do not restart/stop blindly' }
}
if ($Action -eq 'Start') {
 & "$pgBin\pg_ctl.exe" status -D $clusterPath
 if ($LASTEXITCODE -eq 0) { Confirm-ConnectedTarget; Write-Output 'Verified cluster already running'; exit 0 }
 & "$pgBin\pg_isready.exe" -h 127.0.0.1 -p 54322 -t 3
 if ($LASTEXITCODE -ne 2) { throw 'Port is responding; inspect ownership before startup' }
 $starter=Start-Process -FilePath "$pgBin\pg_ctl.exe" -ArgumentList @('start','-D',$clusterPath,'-l',('"'+$logPath+'"'),'-o','"-h 127.0.0.1 -p 54322"','-w','-t','15') -WindowStyle Hidden -PassThru
 if (-not $starter.WaitForExit(20000)) { throw "Startup exceeded 20 seconds. Inspect $logPath; do not issue another start" }
 if ($starter.ExitCode -ne 0) { throw "Startup did not confirm readiness. Inspect $logPath; do not issue another start" }
 Confirm-ConnectedTarget
} elseif ($Action -eq 'Stop') {
 Confirm-ConnectedTarget
 & "$pgBin\pg_ctl.exe" stop -D $clusterPath -m fast -w -t 15
 if ($LASTEXITCODE -ne 0) { throw 'Bounded shutdown failed; inspect cluster, do not kill unrelated processes' }
} else {
 & "$pgBin\pg_ctl.exe" status -D $clusterPath
 & "$pgBin\pg_isready.exe" -h 127.0.0.1 -p 54322 -t 3
 if ($LASTEXITCODE -eq 0) { Confirm-ConnectedTarget }
}
Write-Output "Cluster: $clusterPath; startup log: $logPath"
