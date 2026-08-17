# VixSrc Stream API — Render Deployment

## Deploy to Render (Step by Step)

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "initial"
git remote add origin https://github.com/YOUR_USERNAME/vixsrc-render.git
git push -u origin main
```

### 2. Create Render Web Service
1. Go to https://render.com → **New → Web Service**
2. Connect your GitHub repo
3. Fill in settings:
   - **Name**: vixsrc-api (anything you like)
   - **Region**: Oregon (or nearest to you)
   - **Branch**: main
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free

4. Click **Create Web Service**

### 3. Use the API
Once deployed, your service URL will be:
```
https://your-service-name.onrender.com
```

#### Get movie stream:
```
GET https://your-service-name.onrender.com/stream?id=280
```

#### Example response:
```json
{
  "master_m3u8": "https://cdn.example.com/hls/movie.m3u8?token=xxx",
  "raw_m3u8": "#EXTM3U\n#EXT-X-STREAM-INF:..."
}
```

## Notes
- Proxies are randomly selected per request for load balancing
- The free Render tier spins down after 15 min of inactivity (first request will be slow)
- Upgrade to Starter ($7/mo) for always-on service
