# things nobody asked for

Software with a target audience of one (me). Nobody asked for any of it. I built it anyway, mostly so I could check on things from bed instead of opening a laptop.

Each tool lives on its own branch with its full history. `main` only holds this README.

| Tool | What it does | Branch | Download |
|---|---|---|---|
| **watchBoard** | Watch your Weights & Biases training runs from your phone | [`watchboard`](https://github.com/atikulmunna/things-nobody-asked-for/tree/watchboard) | [1.0.1](https://github.com/atikulmunna/things-nobody-asked-for/releases/tag/watchboard-v1.0.1) |
| **cloudBoard** | Check on your AWS account from your phone, strictly read-only | [`cloudboard`](https://github.com/atikulmunna/things-nobody-asked-for/tree/cloudboard) | [1.0.0](https://github.com/atikulmunna/things-nobody-asked-for/releases/tag/cloudboard-v1.0.0) |

## watchBoard

<p>
  <img src="https://raw.githubusercontent.com/atikulmunna/things-nobody-asked-for/watchboard/docs/screenshots/dashboard.png" width="24%" alt="Dashboard">
  <img src="https://raw.githubusercontent.com/atikulmunna/things-nobody-asked-for/watchboard/docs/screenshots/charts.png" width="24%" alt="Run charts">
  <img src="https://raw.githubusercontent.com/atikulmunna/things-nobody-asked-for/watchboard/docs/screenshots/logs.png" width="24%" alt="Console logs">
  <img src="https://raw.githubusercontent.com/atikulmunna/things-nobody-asked-for/watchboard/docs/screenshots/menu.png" width="24%" alt="Menu">
</p>

An Android app for keeping an eye on Weights & Biases training runs, so you can find out your run crashed at epoch 3 without walking back to your desk.

- Dashboard of live, crashed and recently finished runs across your projects and teams, refreshed every 30 seconds
- Object detection runs (Ultralytics YOLO, RT-DETR) show the epoch plus mAP50 and mAP50-95 with their trend
- Run pages with metric charts, summary and config, GPU/CPU/memory, live console logs, files and artifacts
- Sweeps, artifacts, registry, reports and Weave traces
- Stop a run, or pause, resume and stop a sweep, each behind a confirmation
- Also runs as a small web server (`server.js`) for browsers on your network

Paste your API key from [wandb.ai/authorize](https://wandb.ai/authorize) on first launch. Dedicated Cloud and self-hosted W&B servers can set their own API host.

## cloudBoard

<p>
  <img src="https://raw.githubusercontent.com/atikulmunna/things-nobody-asked-for/cloudboard/docs/screenshots/home.png" width="24%" alt="Home">
  <img src="https://raw.githubusercontent.com/atikulmunna/things-nobody-asked-for/cloudboard/docs/screenshots/s3.png" width="24%" alt="S3 bucket">
  <img src="https://raw.githubusercontent.com/atikulmunna/things-nobody-asked-for/cloudboard/docs/screenshots/alarm.png" width="24%" alt="CloudWatch alarm">
  <img src="https://raw.githubusercontent.com/atikulmunna/things-nobody-asked-for/cloudboard/docs/screenshots/menu.png" width="24%" alt="Advanced mode menu">
</p>

A read-only Android app for checking your AWS account from your phone. It can look at everything and touch nothing, which is exactly the level of power you want at 2 AM.

- **S3**: buckets from every region, a folder browser, file previews and 15-minute signed download links
- **SQS**: queue depths, dead-letter routing, CloudWatch charts and a peek at up to 10 messages
- **CloudWatch**: alarms with state history, a metric browser, and log search with live follow
- **Advanced mode**: ECS, EC2, Lambda, DynamoDB, RDS, SNS, month-to-date cost and a permissions check
- Long-press anything to pin it to the top
- Keys are encrypted in the Android Keystore, every request is signed in native code, and read-only is enforced natively, not just promised

Use a dedicated IAM user. The minimal policy is in the app under Settings.

## Getting the code

Clone just the tool you want:

```
git clone -b watchboard --single-branch https://github.com/atikulmunna/things-nobody-asked-for.git watchBoard
git clone -b cloudboard --single-branch https://github.com/atikulmunna/things-nobody-asked-for.git cloudBoard
```

Both are [Capacitor](https://capacitorjs.com) apps: plain HTML, CSS and JavaScript packaged for Android. Building needs Node.js 18 or newer and Android Studio. Each branch's README has the build steps.

Both APKs need Android 7.0 or newer.

## License

MIT, on each branch. Not affiliated with Weights & Biases, CoreWeave or Amazon Web Services.
