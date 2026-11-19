#!/bin/sh
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is not set. Set it in the container's environment before starting." >&2
  exit 1
fi

# Extract database connection details from DATABASE_URL
PG_HOST=$(echo "$DATABASE_URL" | sed -E 's#.*@([^:/]+).*#\1#')
PG_PORT=$(echo "$DATABASE_URL" | sed -E 's/.*:([0-9]*)\/.*/\1/')
PG_PORT=${PG_PORT:-5432}

if [ -z "$PG_HOST" ]; then
  echo "Could not parse a host out of DATABASE_URL." >&2
  exit 1
fi

# Wait for database to be ready
echo "Waiting for database to be ready..."
while ! nc -z "$PG_HOST" "$PG_PORT"; do
  sleep 1
done
echo "Database is ready!"

# Generate Prisma Client
echo "Generating Prisma Client..."
node ./node_modules/prisma/build/index.js generate

# Run database migrations
echo "Running database migrations..."
node ./node_modules/prisma/build/index.js migrate deploy

# Start the application
echo "Starting the application..."
exec "$@" 