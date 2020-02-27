FROM node:12-slim

WORKDIR /app

COPY package.json ./
COPY *.lock ./

RUN npm install

COPY . .

CMD npm start