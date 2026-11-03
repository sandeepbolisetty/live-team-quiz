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


## Camera-Based Mobile-Phone Detection (YOLO)

The optional camera-monitoring deployment uses a separate Python service defined in `render.yaml`.

1. Deploy the repository using the Render Blueprint so both `live-team-quiz` and `live-team-quiz-camera` services are created.
2. Generate one long random secret (at least 32 characters).
3. Set `CAMERA_SERVICE_TOKEN` to that exact same secret in **both** Render services.
4. In the Node service, set `CAMERA_SERVICE_URL` to the actual HTTPS URL of the Python camera service.
5. Redeploy both services and check their `/health` endpoints.

Participants must explicitly accept the camera notice and grant browser camera permission. The browser sends low-resolution JPEG snapshots only while a quiz question is visible. The Python service runs YOLO in memory and does not save submitted images or video. Only warning events, confidence values, and timestamps are stored in the quiz database.

The detector looks for the COCO `cell phone` class. It requires repeated detections across multiple frames before recording a warning; two warnings are followed by elimination on the third camera warning. This is an imperfect visual detector: it can miss phones and can produce false positives. A camera detection is not proof of misconduct, so the host should review the recorded event and provide a way to challenge mistakes. Participants should use a separate device for the quiz when possible, keep their own quiz phone outside the camera view, and position the camera to show the relevant area without unnecessarily capturing other people.

The Python service uses a Render Standard instance because computer-vision model inference requires more memory and CPU than the Node quiz server. Confirm the current Render plan price before deploying.
