FROM node:20-alpine

WORKDIR /app

# Copy package.json and install dependencies (just express for the launcher)
COPY package.json ./
RUN npm install --omit=dev

# Copy the rest of the bsdk files (launcher.js, server-ai.js, server-ai-mybot.js, etc)
COPY . .

# The Express app listens on 8080
EXPOSE 8080

CMD ["npm", "start"]
