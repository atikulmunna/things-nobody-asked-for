FROM node:22-alpine
WORKDIR /app
RUN chown node:node /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node public ./public
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production
EXPOSE 8787
USER node
CMD ["node", "server.js"]
