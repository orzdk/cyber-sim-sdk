# Bot launcher image (cyber-sim-sdk).
#
# Build context is the MONOREPO ROOT, not this folder: the image needs engine/
# next to bsdk/ so the bots can look ahead with the real rules engine
# (server-ai-mybot-v3.js requires ../engine). Deploy with the bats in /bat:
#   flyctl deploy . --config bsdk/fly.toml --ignorefile bsdk/.dockerignore ...
# Building from inside bsdk/ fails on the first COPY — on purpose, so an
# engine-less image can't ship by accident.
FROM node:20-alpine

WORKDIR /app/bsdk

COPY bsdk/package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# engine has no dependencies — a plain copy is the whole install
COPY engine/ /app/engine/
COPY bsdk/ ./

EXPOSE 8080

CMD ["npm", "start"]
