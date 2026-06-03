# Static CDN for Figma plugin WASM and worker assets.
# Content is prepared by scripts/publish-cdn.sh and copied into content/ before build.
FROM nginx:alpine

# Copy pre-built content (wasm/, worker.js)
COPY content/ /usr/share/nginx/html/

# CORS and MIME types for WASM (set in nginx.conf location)
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
