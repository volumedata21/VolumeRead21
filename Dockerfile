# Use an official Python runtime as a parent image
FROM python:3.11-slim

# Set the working directory in the container
WORKDIR /app

# *** FIX: Force Python to print logs immediately (Disable Buffering) ***
ENV PYTHONUNBUFFERED=1

# Copy the requirements file and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code into the container
COPY . .

# Make port 5000 available to the world outside this container
EXPOSE 5000

# Add executable permissions to the entrypoint script
RUN chmod +x /app/entrypoint.sh

# Use the entrypoint script to run migrations *before* starting the app
ENTRYPOINT ["/app/entrypoint.sh"]