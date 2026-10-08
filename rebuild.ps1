 = @(
"202609100001_ksc_v1_foundation.sql",
"202609110002_test_builder.sql",
"202609110003_student_exam_engine.sql",
"202609110004_fix_rls.sql",
"202609110005_results_foundation.sql",
"202609110006_fix_results_types.sql",
"202609110007_content_hierarchy.sql"
)
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -p 54322 -c "DROP DATABASE IF EXISTS supabase_local;"
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -p 54322 -c "CREATE DATABASE supabase_local;"
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -p 54322 -d supabase_local -f scripts\setup_auth.sql
foreach ($m in $migrations) {
    Write-Host "Applying $m"
    & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -v ON_ERROR_STOP=1 -U postgres -p 54322 -d supabase_local -f "supabase\migrations\"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed on $m"
        break
    }
}
