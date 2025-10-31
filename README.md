## VolumeRead21 | Simple Self-Hosted RSS Feed App

<img width="1567" height="1163" alt="Captura de pantalla 2025-10-31 a la(s) 12 37 24 a m" src="https://github.com/user-attachments/assets/9103d3de-5788-47f5-8fb6-40b924c470dd" /> &nbsp;
<img width="1580" height="1157" alt="Captura de pantalla 2025-10-31 a la(s) 12 37 46 a m" src="https://github.com/user-attachments/assets/d8f46588-df77-400d-8feb-9292bd6d9bb4" />

### Features
- Store articles locally
- Search entire feed
- Share articles
- Save favorites indefinitely
- Save bookmarks
- Self hosted
- Launch with Docker

### How to use
Copy and paste an rss feed URL into the "Add feed URL..." box. There are a few great tools out there you can use to convert nearly any website, blog, review site, or YouTube channel into an RSS feed link.
#### Streams and Categories
When you add a feed, it will automatically be placed in "Uncategorized". You can put feeds into different categories, and click the categories to view only those feeds. Streams are just a second way of organizing feeds. You can mix feeds from different categories into separate streams. For exmaple, if you could creat a stream called "Morning News" that's a mix of sports, self hosted news and maybe some music feeds.

## Installation

#### To launch via command line
1. `cd [your-directory, for me usually ~/appdata]`
2. `mkdir volumeread21`
3. `cd volumeread21`
4. `mkdir data`
5. `nano compose.yaml`
6. Copy and paste contents of compose.yaml, hit "ctrl+x" to exit, "y" to save.
7. `docker compose up -d`

If you run into permission issues, make sure to chown the data directory to your user.
`sudo chown -R 1000:1000 data`

### compose.yaml with bind mount
```
services:
  volumeread21:
    image: volumedata21/volumeread21:latest
    container_name: volumeread21
    ports:
      - "2122:5000"
    volumes:
      - ./data:/data
    restart: unless-stopped
    environment:
      - FLASK_DEBUG=0
      - DATA_DIR=/data
    user: "1000:1000"
    restart: unless-stopped
```

Keep `user: "1000:1000"` if you don't want to run as root. If you don't create a data folder before launching, you'll most likely have to chown the directly for user 1000 (or whoever your user is when you type in 'id').

### compose.yaml with Docker volume
```
services:
  volumeread21:
    image: volumedata21/volumeread21:latest
    container_name: volumeread21
    ports:
      - "2122:5000"
    volumes:
      - rss_data:/data
    restart: unless-stopped
    environment:
      - FLASK_DEBUG=0
      - DATA_DIR=/data
    restart: unless-stopped
volumes:
  rss_data:
```
This should run without any permission issues. And you don't have to create any directories. Trickier to backup if needed.

### I am not a professional developer. 
This is a mix of mostly vibe-code with my minimal coding knowledge of html, css, and Docker. I recommend only deploying this app locally.

#### Known Issues
- Sometimes images will go beyond width of the article
- "Uncategorized" will expand automatically when dragging a feed into a stream.
