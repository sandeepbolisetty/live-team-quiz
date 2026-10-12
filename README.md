# Live Team Quiz System

A real-time online team quiz application with team registration, live questions, and a buzzer system.

## Features

- Team registration with team name and participant registration numbers.
- Real-time quiz questions.
- Buzzer system for teams to request answering.
- Buzzer sound notification.
- Live synchronization between host and participants.
- Question management by the quiz host.
- Online access from mobile phones and computers.
- Responsive user interface.

## Technologies Used

- HTML
- CSS
- JavaScript
- Node.js
- Express.js
- Socket.IO

## Project Structure

```text
live-team-quiz/
├── server.js
├── package.json
├── render.yaml
├── README.md
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

## Requirements

- Node.js
- npm
- A modern web browser

## Run Locally

### 1. Install dependencies

Open a terminal in the project directory and run:

```bash
npm install
```

### 2. Start the server

```bash
npm start
```

### 3. Open the application

Visit the local URL configured by the server, usually:

```text
http://localhost:3000
```

## Deploy Online Using Render

1. Upload this repository to GitHub.
2. Sign in at https://render.com/.
3. Create a new Web Service.
4. Connect the `live-team-quiz` GitHub repository.
5. Set the build command to:

```bash
npm install
```

6. Set the start command to:

```bash
npm start
```

7. Deploy the application.
8. Share the deployed URL with quiz participants.

The server must listen on the port provided by the `PORT` environment variable for deployment.

## How to Use

1. The host opens the quiz application.
2. Participants join using the shared link.
3. Each team registers its name and members' registration numbers.
4. The host starts the quiz.
5. Teams use the buzzer when they want to answer.
6. The host manages questions and scores.

## Notes

- Real-time communication requires server-side event handling, such as Socket.IO.
- All participants must connect to the same deployed quiz server.
- Host controls should be protected from unauthorized access.
- Test the application with multiple devices before the competition.

## License

This project is intended for educational purposes and quiz competitions.

## Project Information

**Project Name:** Live Team Quiz System  
**Purpose:** Online team quiz competitions with real-time buzzer functionality.
