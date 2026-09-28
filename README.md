# waste-packaging-regulator-perf

A JMeter based test runner for the CDP Platform.

- [Licence](#licence)
  - [About the licence](#about-the-licence)

## Build

Test suites are built automatically by the [.github/workflows/publish.yml](.github/workflows/publish.yml) action whenever a change are committed to the `main` branch.
A successful build results in a Docker container that is capable of running your tests on the CDP Platform and publishing the results to the CDP Portal.

## Run

The performance test suites are designed to be run from the CDP Portal.
The CDP Platform runs test suites in much the same way it runs any other service, it takes a docker image and runs it as an ECS task, automatically provisioning infrastructure as required.

## Local Testing Against `npm run dev`

`user.properties` defaults to the perf-test proxy (see below). To point at each app's local `npm run dev` server instead, override the host properties to `localhost`/`127.0.0.1`, port `3000`/`7154`, `PROTOCOL=http`:

```bash
DASHBOARD_HOST=127.0.0.1 COMPLIANCE_HOST=localhost \
PROTOCOL=http DASHBOARD_PORT=7154 COMPLIANCE_PORT=3000 \
./run-tests.sh
```

(`DASHBOARD_HOST` and `COMPLIANCE_HOST` must differ, even though both resolve to loopback — JMeter's cookie jar scopes cookies by hostname only, not port, so identically-named "session" cookies from the two unrelated apps would otherwise collide.)

Locally, both apps run with `MOCK_AUTH=true` by default, which bypasses Azure AD B2C entirely — `get-session-cookie.js` detects this and signs in as the fixed mock user without needing `B2C_USERNAME`/`B2C_PASSWORD`. Those credentials are only required when pointing at a real B2C-backed environment (dev, perf-test). Note that the local mock backend (`MOCK_API=true`) is read-only — it accepts accept/cancel submissions without error but never persists the change, so the suite's post-mutation assertions (confirmation banners, updated status) can't pass against it; only the navigation, CSRF and session-handling steps are meaningfully verifiable locally.

## Running Against perf-test

`user.properties` defaults to `COMPLIANCE_HOST=DASHBOARD_HOST=regulators-waste-proxy.perf-test.cdp-int.defra.cloud` (`PROTOCOL=https`, port `443`) — the YARP proxy that fronts both apps in perf-test. With `B2C_USERNAME`/`B2C_PASSWORD` set (in `.env` or the environment):

```bash
./run-tests.sh
```

This is a real, shared environment — the accept/cancel thread groups genuinely mutate whichever pending/accepted submissions they find there.

The "Accept a Pending Submission" and "Cancel an Accepted Submission & Search for It" thread groups — for both direct producers and compliance schemes — each run a single mutating journey rather than a sustained load, since every iteration permanently consumes one submission's state:

- **Accept**: finds the first pending submission, opens its accept form, submits it, and checks for the accepted confirmation banner.
- **Cancel, search & verify**: finds the first accepted submission, cancels it, searches for it by organisation name and checks it now shows a "Cancelled" tag, then clicks through to its detail page (compliance schemes only) and checks the cancellation reason renders there too.

Make sure the target environment has pending and accepted submissions seeded for both direct producers and compliance schemes before running.

## Local Testing with Docker Compose

You can run the entire performance test stack locally using Docker Compose, including LocalStack, Redis, and the target service. This is useful for development, integration testing, or verifying your test scripts **before committing to `main`**, which will trigger GitHub Actions to build and publish the Docker image.

### Build the Docker image

```bash
docker compose build --no-cache development
```

This ensures any changes to `entrypoint.sh` or other scripts are picked up properly.

---

### Start the full test stack

```bash
docker compose up --build
```

This brings up:

* `development`: the container that runs your performance tests
* `localstack`: simulates AWS S3, SNS, SQS, etc.
* `redis`: backing service for cache
* `service`: the application under test

Once all services are healthy, your performance tests will automatically start.

---

### Replace `service-name` in Compose File

In the `docker-compose.yml`, make sure to replace:

```yaml
image: defradigital/service-name:${SERVICE_VERSION:-latest}
```

with the actual name of your service’s image.

This is the service under test, which must expose a `/health` endpoint and listen on port `3000`.

---

### Notes

* S3 bucket is expected to be `s3://test-results`, automatically created inside LocalStack.
* Logs and reports are written to `./reports` on your host.
* `entrypoint.sh` should contain the logic to wait for dependencies and kick off the test run.
* The `depends_on` healthchecks ensure services like `localstack` and `service` are ready before tests start.
* If you make changes to test scripts or entrypoints, rerun with:

```bash
docker compose up --build
```

## Local Testing with LocalStack

### Build a new Docker image
```
docker build . -t my-performance-tests
```
### Create a Localstack bucket
```
aws --endpoint-url=localhost:4566 s3 mb s3://my-bucket
```

### Run performance tests

```
docker run \
-e S3_ENDPOINT='http://host.docker.internal:4566' \
-e RESULTS_OUTPUT_S3_PATH='s3://my-bucket' \
-e AWS_ACCESS_KEY_ID='test' \
-e AWS_SECRET_ACCESS_KEY='test' \
-e AWS_SECRET_KEY='test' \
-e AWS_REGION='eu-west-2' \
my-performance-tests
```

docker run -e S3_ENDPOINT='http://host.docker.internal:4566' -e RESULTS_OUTPUT_S3_PATH='s3://cdp-infra-dev-test-results/cdp-portal-perf-tests/95a01432-8f47-40d2-8233-76514da2236a' -e AWS_ACCESS_KEY_ID='test' -e AWS_SECRET_ACCESS_KEY='test' -e AWS_SECRET_KEY='test' -e AWS_REGION='eu-west-2' -e ENVIRONMENT='perf-test' my-performance-tests


## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

<http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3>

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government licence v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable
information providers in the public sector to license the use and re-use of their information under a common open
licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
