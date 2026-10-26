# Run all regression test suites
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       SUBTRANS - REGRESSION TEST SUITE RUNNER            " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$testFiles = @(
    "frontend/src/lib/subtitles.node-test.mjs",
    "scripts/test_step2.mjs",
    "scripts/test_step3.mjs",
    "scripts/test_step4.mjs",
    "scripts/test_step5.mjs"
)

$hasError = $false

foreach ($tf in $testFiles) {
    Write-Host "`n[RUNNING TEST] $tf..." -ForegroundColor Yellow
    node --test $tf
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAILED] $tf failed!" -ForegroundColor Red
        $hasError = $true
        break
    } else {
        Write-Host "[SUCCESS] $tf passed 100%!" -ForegroundColor Green
    }
}

Write-Host "`n==========================================================" -ForegroundColor Cyan
if ($hasError) {
    Write-Host "RESULT: TESTS FAILED - PLEASE CHECK THE ERRORS ABOVE" -ForegroundColor Red
    exit 1
} else {
    Write-Host "RESULT: ALL TESTS PASSED SUCCESSFULLY (100% PASS)!" -ForegroundColor Green
}
Write-Host "==========================================================" -ForegroundColor Cyan
