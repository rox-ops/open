FROM apify/actor-node-playwright:latest

COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY actor.json input_schema.json README.md ./

CMD ["npm", "start"]