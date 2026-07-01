FROM defradigital/cdp-perf-test-docker:latest

WORKDIR /opt/perftest

# Install Node.js if not already present in the base image (needed for B2C auth script).
RUN command -v node > /dev/null 2>&1 || apk add --no-cache nodejs

COPY scenarios/ ./scenarios/
COPY entrypoint.sh .
COPY user.properties .
COPY package.json .
COPY get-session-cookie.js .

ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com
ENV TEST_SCENARIO=certificates-of-compliance-perf

ENTRYPOINT [ "./entrypoint.sh" ]
