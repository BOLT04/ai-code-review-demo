FROM node:22-alpine
WORKDIR /app
COPY server.js .
RUN echo '{"type":"module"}' > package.json
EXPOSE 3000
CMD ["node", "server.js"]
