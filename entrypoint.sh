#!/bin/sh

# This script runs before the main app starts
echo "Starting entrypoint script..."

# Ensure the data directory exists
if [ -n "$DATA_DIR" ] && [ ! -d "$DATA_DIR" ]; then
    echo "Creating data directory: $DATA_DIR"
    mkdir -p "$DATA_DIR"
fi

# Set FLASK_APP environment variable for flask commands
export FLASK_APP=app.py

# Run the database migrations
# This will apply any pending changes (like adding new columns)
# to the app.db file without deleting it.
echo "Running database migrations..."
flask db upgrade
echo "Database migrations complete."

# Run the app's own initialization (creates 'Uncategorized')
# We run this *after* migrations to ensure tables exist
echo "Running app initialization..."
python -c 'from app import initialize_database; initialize_database()'
echo "App initialization complete."

# Now, start the Gunicorn server
echo "Starting Gunicorn..."
exec gunicorn --workers 4 --bind 0.0.0.0:5000 app:app