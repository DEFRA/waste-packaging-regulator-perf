FROM defradigital/cdp-perf-test-docker:latest

WORKDIR /opt/perftest

RUN apk add --no-cache nodejs

COPY scenarios/ ./scenarios/
COPY entrypoint.sh .
COPY user.properties .
COPY package.json .
COPY get-session-cookie.js .

ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com
ENV TEST_SCENARIO=certificates-of-compliance-perf

ENTRYPOINT [ "./entrypoint.sh" ]
