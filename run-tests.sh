#!/bin/sh
set -e

# Load local credentials from .env if present (gitignored — never committed).
# Parsed with read rather than sourced so special chars in values are safe.
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '#'*|'') continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    export "$key=$value"
  done < .env
fi

echo "Authenticating..." >&2
COMPLIANCE_SESSION_COOKIE=$(node get-session-cookie.js)

NOW=$(date +"%Y%m%d-%H%M%S")
mkdir -p results

jmeter -n \
  -t scenarios/certificates-of-compliance-perf.jmx \
  -q user.properties \
  -JCOMPLIANCE_SESSION_COOKIE="${COMPLIANCE_SESSION_COOKIE}" \
  -l results/${NOW}-certificates-of-compliance.jtl \
  -e -o results/${NOW}-certificates-of-compliance-report \
  -j results/${NOW}-certificates-of-compliance.log \
  -f

echo "" >&2
echo "Report written to results/${NOW}-certificates-of-compliance-report" >&2
