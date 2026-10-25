FROM node:24.22.1-bookworm-slim
WORKDIR /agent
COPY *.js package.json ./
USER node
EXPOSE 9010
CMD ["node", "app.js"]
