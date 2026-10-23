FROM node:24-alpine
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build
# roles/, prompts/, context/ are mounted at runtime
CMD ["node", "dist/server.js"]
