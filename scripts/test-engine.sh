#!/bin/sh
# Runs every test in throw-away containers — a fresh, empty MongoDB each time. The real database and the
# running app are never touched. Usage (from anywhere):  sh scripts/test-engine.sh
#   1) reader unit tests   2) engine scenarios (docs/ENGINE.md §4)   3) end-to-end API test
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
ID="fblf-test-$$"
IMAGE="$ID-image"
cleanup() {
  docker rm -f "$ID-mongo" "$ID-app" >/dev/null 2>&1 || true
  docker network rm "$ID" >/dev/null 2>&1 || true
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "== building the app image"
docker build -q -t "$IMAGE" . >/dev/null
docker network create "$ID" >/dev/null
docker run -d --name "$ID-mongo" --network "$ID" mongo:7 >/dev/null
MONGO="mongodb://$ID-mongo:27017"
until docker exec "$ID-mongo" mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1; do sleep 1; done

TESTS="-v $ROOT/server/test:/app/server/test:ro"
FAILED=0

echo "== 1) reader unit tests"
docker run --rm $TESTS "$IMAGE" node --test test/reader.test.mjs || FAILED=1

echo "== 2) engine scenarios (empty test database)"
docker run --rm --network "$ID" -e MONGODB_URI="$MONGO" -e DB_NAME=engine_test $TESTS "$IMAGE" node --test --test-concurrency=1 test/engine.test.mjs || FAILED=1

echo "== 3) end-to-end API test (a test copy of the app on an empty database)"
docker run -d --name "$ID-app" --network "$ID" -e MONGODB_URI="$MONGO" -e DB_NAME=e2e_test -e WORKER_KEY=e2e-test-key \
  -v "$ROOT/server/test/e2e.mjs:/app/server/e2e.mjs:ro" "$IMAGE" >/dev/null
until docker exec "$ID-app" wget -qO- http://127.0.0.1:4000/api/health >/dev/null 2>&1; do sleep 1; done
docker exec "$ID-app" node e2e.mjs || FAILED=1

[ "$FAILED" = 0 ] && echo "\nALL TEST SUITES PASSED" || { echo "\nSOME TESTS FAILED"; exit 1; }
