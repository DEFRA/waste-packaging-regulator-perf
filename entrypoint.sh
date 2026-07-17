#!/bin/sh
# Note: set -x is intentionally absent — it would print the session cookie to CI logs.

echo "run_id: $RUN_ID in $ENVIRONMENT"

NOW=$(date +"%Y%m%d-%H%M%S")

if [ -z "${JM_HOME}" ]; then
  JM_HOME=/opt/perftest
fi

JM_REPORTS=${JM_HOME}/reports
JM_LOGS=${JM_HOME}/logs

mkdir -p ${JM_REPORTS} ${JM_LOGS}

export COMPLIANCE_HOST="${COMPLIANCE_HOST:-waste-packaging-regulators-fe.${ENVIRONMENT}.cdp-int.defra.cloud}"

# ── Authentication ─────────────────────────────────────────────────────────────
# B2C_USERNAME and B2C_PASSWORD must be injected as CI secrets (never stored in files).
# COMPLIANCE_SESSION_COOKIE can be pre-set to skip auth (useful in local debugging).
if [ -z "${COMPLIANCE_SESSION_COOKIE}" ]; then
  if [ -z "${B2C_USERNAME}" ] || [ -z "${B2C_PASSWORD}" ]; then
    echo "Error: B2C_USERNAME and B2C_PASSWORD env vars are required." >&2
    exit 1
  fi
  echo "Authenticating with Azure AD B2C..." >&2
  COMPLIANCE_SESSION_COOKIE=$(node "${JM_HOME}/get-session-cookie.js") || {
    echo "Error: get-session-cookie.js failed — check B2C credentials." >&2
    exit 1
  }
fi

# ── JMeter run ─────────────────────────────────────────────────────────────────
SCENARIO=${TEST_SCENARIO:-certificates-of-compliance-perf}
REPORTFILE=${JM_LOGS}/${NOW}-${SCENARIO}.jtl
LOGFILE=${JM_LOGS}/${NOW}-${SCENARIO}.log

jmeter -n \
  -t "${JM_HOME}/scenarios/${SCENARIO}.jmx" \
  -e -l "${REPORTFILE}" \
  -o "${JM_REPORTS}" \
  -j "${LOGFILE}" \
  -f \
  -q ${JM_HOME}/user.properties \
  -JDASHBOARD_HOST="${DASHBOARD_HOST:-waste-regulator-dashboard-fe.${ENVIRONMENT}.cdp-int.defra.cloud}" \
  -JCOMPLIANCE_HOST="${COMPLIANCE_HOST}" \
  -JTHREADS="${THREADS:-10}" \
  -JRAMP_UP="${RAMP_UP:-30}" \
  -JDURATION="${DURATION:-120}" \
  -JRESPONSE_TIME_THRESHOLD_MS="${RESPONSE_TIME_THRESHOLD_MS:-3000}" \
  -JDASHBOARD_SESSION_COOKIE="${DASHBOARD_SESSION_COOKIE:-}" \
  -JCOMPLIANCE_SESSION_COOKIE="${COMPLIANCE_SESSION_COOKIE}"

test_exit_code=$?

# ── Publish results to S3 ──────────────────────────────────────────────────────
if [ -n "$RESULTS_OUTPUT_S3_PATH" ]; then
  if [ -f "$JM_REPORTS/index.html" ]; then
    aws --endpoint-url=$S3_ENDPOINT s3 cp "${JM_REPORTS}" "$RESULTS_OUTPUT_S3_PATH" --recursive
    echo "Test results published to $RESULTS_OUTPUT_S3_PATH"
  else
    echo "$JM_REPORTS/index.html not found — JMeter may have failed before producing a report"
    exit 1
  fi
else
  echo "RESULTS_OUTPUT_S3_PATH is not set"
  exit 1
fi

exit $test_exit_code
