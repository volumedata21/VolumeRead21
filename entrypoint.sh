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

# Define the database file path
DB_FILE="$DATA_DIR/app.db"

# --- SMART INITIALIZATION LOGIC ---

if [ -f "$DB_FILE" ]; then
    echo "Database found at $DB_FILE"
    echo "Running database migrations..."
    # If the DB exists, we assume it has the base schema, so we try to upgrade it.
    flask db upgrade
else
    echo "No database file found. Initializing fresh database..."
    
    # 1. Create tables directly from models using your app's logic.
    # This creates the tables WITH the new columns immediately.
    python -c 'from app import initialize_database; initialize_database()'
    
    # 2. Tell Flask-Migrate that we are already at the latest version.
    # This prevents it from trying to run the "add_etag" migration on tables
    # that we just created (which already have the etag column).
    if [ -d "migrations" ]; then
        echo "Stamping database migration head..."
        flask db stamp head
    fi
fi

# Run initialization again just to be safe (e.g. ensuring 'Uncategorized' category exists)
# This is safe to run multiple times.
echo "Ensuring app data is initialized..."
python -c 'from app import initialize_database; initialize_database()'
echo "App initialization complete."

# Now, start the Gunicorn server
echo "Starting Gunicorn..."
exec gunicorn --workers 4 --bind 0.0.0.0:5000 app:app