@echo off
rem Solframe Video Generation Server (port 8766) - does NOT touch the image server on 8765
cd /d D:\genimg_comic
"D:\GPU computation\.venv\Scripts\python.exe" video_server.py >> "D:\genimg_comic\video_server.log" 2>&1
