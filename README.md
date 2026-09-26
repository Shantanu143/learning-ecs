# learning-ecs

A small Node.js (Express) web server that is deployed to AWS automatically every time you push to the `main` branch.

- `GET /` and `GET /health` both reply `Hello, World!`
- It listens on port **3000**

This guide takes you from "nothing set up" to "`git push` deploys my app". You don't need to know AWS beforehand. Every step says **what** it is, **why** it matters, and **how** to do it.

---

## 1. The big picture

### Words you will see

| Term | What it means in plain English |
| --- | --- |
| **Docker image** | A packaged copy of your app plus everything it needs to run (Node.js, libraries). It is built from the [`Dockerfile`](Dockerfile). |
| **ECR** (Elastic Container Registry) | AWS's storage for Docker images. Think of it as a private Docker Hub. |
| **ECS** (Elastic Container Service) | The AWS service that runs your Docker containers. |
| **Fargate** | A mode of ECS where AWS provides the servers. You never create or patch a machine. |
| **Cluster** | A named group in ECS that your running apps belong to. Yours is `test-cluster`. |
| **Task definition** | A recipe that tells ECS how to run your container: which image, how much CPU and memory, which port, where to send logs. It lives in [`.aws/task-definition.json`](.aws/task-definition.json). Each deploy creates a new numbered *revision* of it. |
| **Task** | One running copy of a task definition, meaning one running container. |
| **Service** | The ECS "manager" for your app. It keeps the wanted number of tasks running, restarts them if they crash, and swaps old tasks for new ones during a deploy. |
| **IAM role** | A set of permissions in AWS. Instead of giving a tool a password, you give it a role that allows only specific actions. |
| **GitHub Actions** | GitHub's built-in automation. It runs the pipeline in [`.github/workflows/deploy-ecs.yml`](.github/workflows/deploy-ecs.yml). |
| **OIDC** | A way for GitHub to prove to AWS "I am a workflow from *this* repository", so AWS hands out a temporary login. No permanent AWS password is stored in GitHub. |

### What happens on every push to `main`

```
 you: git push to main
        |
        v
 GitHub Actions  (.github/workflows/deploy-ecs.yml)
   1. logs in to AWS with a temporary login (OIDC)
   2. builds the Docker image from the Dockerfile
   3. pushes the image to ECR            -->  ECR repo: test-services
   4. puts the new image into .aws/task-definition.json
   5. registers it as a new task definition revision
   6. tells the ECS service to use that revision
        |
        v
 ECS service (Fargate)
   pulls the image from ECR, starts a new task, waits for /health to pass,
   then stops the old task.
```

You do the AWS setup below **once**. After that, deploying is just `git push`.

### Names used in this guide

The pipeline and this guide use the names below. If you use different ones, change them in the `env:` block at the top of [`deploy-ecs.yml`](.github/workflows/deploy-ecs.yml).

| Thing | Name |
| --- | --- |
| AWS region | `us-east-1` (N. Virginia) |
| ECR repository | `test-services` |
| ECS cluster | `test-cluster` |
| ECS service | `learning-ecs-service` |
| Task definition family and container name | `learning-ecs` |
| CloudWatch log group | `/ecs/learning-ecs` |
| Task execution role | `ecsTaskExecutionRole` |
| Role for GitHub Actions | `github-actions-deploy-ecs` |
| GitHub secret | `AWS_ROLE_ARN` |

> **Two things to know before you start**
>
> - **Region:** almost everything in AWS belongs to one region. In the top-right of the AWS console, make sure **N. Virginia (us-east-1)** is selected for every step. If you can't find something, a wrong region is the usual reason.
> - **Account ID:** some steps need your 12-digit AWS account ID. Click your name in the top-right of the AWS console and copy the **Account ID**. Wherever you see `<ACCOUNT_ID>` below, replace it with that number. It isn't a secret, but it is kept out of this repo on purpose.

---

## 2. One-time AWS setup

Do these in order. Later steps depend on earlier ones.

### Step 1. Check the ECR repository

- **What:** the place where your Docker images are stored.
- **Why:** the pipeline pushes each new image here, and ECS pulls the image from here when it starts your app. If it doesn't exist, the push fails.
- **How:** you already created it. Confirm it: AWS console, then search for **ECR**, then **Repositories**. You should see **`test-services`**.

### Step 2. Create the log group

- **What:** a folder in CloudWatch (AWS's logging service) where your container's output is stored.
- **Why:** your app's `console.log` output, including crashes and error messages, goes here. It is the first place to look when something breaks. The task definition sends logs to `/ecs/learning-ecs`. If that group doesn't exist, ECS refuses to start the container.
- **How (console):** search for **CloudWatch**, then **Logs**, then **Log groups**, then **Create log group**. Name it exactly `/ecs/learning-ecs` and create it.
- **How (CLI, if you have it):**
  ```bash
  aws logs create-log-group --log-group-name /ecs/learning-ecs --region us-east-1
  ```

### Step 3. Check the task execution role

- **What:** an IAM role that ECS itself uses when it starts your task.
- **Why:** before your app runs, ECS has to pull the image from ECR and write logs to CloudWatch. It needs permission for both. This role gives it that permission. Without it the task fails with an "unable to pull image" error.
- **How:** search for **IAM**, then **Roles**, and search for `ecsTaskExecutionRole`.
  - If it exists, you're done.
  - If not, click **Create role**. For **Trusted entity type** choose **AWS service**. For **Use case** choose **Elastic Container Service**, then **Elastic Container Service Task**. Click **Next**, attach the policy **`AmazonECSTaskExecutionRolePolicy`**, name the role exactly `ecsTaskExecutionRole`, and create it.

### Step 4. Let GitHub log in to AWS (OIDC)

- **What:** you set up trust between GitHub and AWS, so the pipeline can act in your AWS account.
- **Why:** the pipeline must push images and update ECS, and AWS won't allow that without proof of who is asking. The old way is to create an access key and paste it into GitHub. That key never expires and is dangerous if it leaks. With OIDC, GitHub gets a **temporary** login that only works for this repo's `main` branch.

This step has three parts.

#### 4a. Add GitHub as an identity provider

- **Why:** this tells AWS "GitHub is someone whose identity claims I'm willing to check".
- **How:** IAM, then **Identity providers**, then **Add provider**.
  - **Provider type:** OpenID Connect
  - **Provider URL:** `https://token.actions.githubusercontent.com`
  - **Audience:** `sts.amazonaws.com`
  - Click **Add provider**. (If it already exists in your account, skip this part.)

#### 4b. Create the permissions policy

- **Why:** this lists exactly what the pipeline is allowed to do, and nothing more. If the pipeline is ever compromised, the damage is limited to these actions.
- **How:** IAM, then **Policies**, then **Create policy**, then the **JSON** tab. Paste the following, replace every `<ACCOUNT_ID>`, and click **Next**. Name it `github-actions-deploy-ecs-policy` and create it.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LogInToEcr",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "PushImageToEcr",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": "arn:aws:ecr:us-east-1:<ACCOUNT_ID>:repository/test-services"
    },
    {
      "Sid": "RegisterTaskDefinition",
      "Effect": "Allow",
      "Action": ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"],
      "Resource": "*"
    },
    {
      "Sid": "UpdateTheService",
      "Effect": "Allow",
      "Action": ["ecs:DescribeServices", "ecs:UpdateService"],
      "Resource": "arn:aws:ecs:us-east-1:<ACCOUNT_ID>:service/test-cluster/learning-ecs-service"
    },
    {
      "Sid": "HandExecutionRoleToEcs",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/ecsTaskExecutionRole",
      "Condition": {
        "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" }
      }
    }
  ]
}
```

#### 4c. Create the role GitHub will use

- **Why:** this is the role the pipeline "becomes" while it runs. It combines *who may use it* (only this repo's `main` branch) with *what it may do* (the policy from 4b).
- **How:** IAM, then **Roles**, then **Create role**.
  1. **Trusted entity type:** **Custom trust policy**. Paste the following, replace `<ACCOUNT_ID>`, and click **Next**.

     ```json
     {
       "Version": "2012-10-17",
       "Statement": [
         {
           "Effect": "Allow",
           "Principal": {
             "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
           },
           "Action": "sts:AssumeRoleWithWebIdentity",
           "Condition": {
             "StringEquals": {
               "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
             },
             "StringLike": {
               "token.actions.githubusercontent.com:sub": "repo:Shantanu143/learning-ecs:ref:refs/heads/main"
             }
           }
         }
       ]
     }
     ```

     The `sub` line is the important safety check. It says only workflows from the repo `Shantanu143/learning-ecs` running on the `main` branch may use this role.
  2. On the permissions page, tick **`github-actions-deploy-ecs-policy`** (from 4b) and click **Next**.
  3. Name the role `github-actions-deploy-ecs` and create it.
  4. Open the role and **copy its ARN**. It looks like `arn:aws:iam::<ACCOUNT_ID>:role/github-actions-deploy-ecs`. You need it in the next step.

### Step 5. Save the role ARN as a GitHub secret

- **What:** a private setting stored in GitHub, which the workflow reads as `secrets.AWS_ROLE_ARN`.
- **Why:** the workflow needs to know *which* role to log in as. It is stored as a secret so it isn't hard-coded in the repo.
- **How:** on GitHub, open the repo, then **Settings**, then **Secrets and variables**, then **Actions**, then **New repository secret**.
  - **Name:** `AWS_ROLE_ARN`
  - **Secret:** the ARN you copied in step 4c
  - Click **Add secret**.

### Step 6. Run the pipeline once (it will fail at the last step, and that is expected)

- **What:** the first run of the pipeline, before the ECS service exists.
- **Why:** ECS can't create a service without a task definition to run, and the pipeline is what registers your task definition and uploads your image. So this first run creates both, and then stops because there is no service to update yet.
- **How:** push a commit to `main`, or on GitHub go to **Actions**, then **Deploy to ECS**, then **Run workflow**. Wait for it to finish.
- **What you should see:**
  - The steps **Checkout**, **Configure AWS credentials**, **Login to Amazon ECR**, **Build and push image** and **Render task definition** all pass (green).
  - The last step, **Deploy to Amazon ECS**, fails with an error ending in `service/test-cluster/learning-ecs-service is MISSING`. That is fine. It only means the service doesn't exist yet.
  - Check the results. In **ECR**, `test-services` now has an image tagged with your commit SHA. In **ECS**, then **Task definitions**, there is now a `learning-ecs` family with revision 1.
- **If it fails at an earlier step,** go to [Troubleshooting](#4-troubleshooting).

### Step 7. Create the ECS service

- **What:** the ECS service that runs and looks after your app.
- **Why:** it is what actually keeps your app running, restarts it if it crashes, and swaps in new versions when the pipeline deploys.
- **How:** search for **ECS**, then **Clusters**, then **`test-cluster`**, then the **Services** tab, then **Create**. Fill in:

  | Field | Value | Why |
  | --- | --- | --- |
  | **Compute options** / Launch type | **Fargate** | AWS runs the server for you. |
  | **Application type** | Service | A long-running app, not a one-off job. |
  | **Task definition** family | `learning-ecs` | The recipe registered in step 6. |
  | **Revision** | latest | |
  | **Service name** | `learning-ecs-service` | It **must match** `ECS_SERVICE` in the workflow and the policy in step 4b. |
  | **Desired tasks** | `1` | One running copy is enough for learning. |
  | **VPC** | your default VPC | The network the task runs in. |
  | **Subnets** | the default (public) subnets | |
  | **Security group** | create a new one with an inbound rule: **Custom TCP, port `3000`, source Anywhere** | A security group is a firewall. Your app listens on 3000, so 3000 has to be open. "Anywhere" is fine for a hello-world. Tighten it for anything real. |
  | **Public IP** | **On** | Fargate has to reach ECR to download your image. In a public subnet that requires a public IP. If this is off, the task fails with `CannotPullContainerError`. |
  | **Load balancer** | none | Not needed for now. |

  Click **Create** and wait a minute or two until the service shows a running task.

### Step 8. Run the pipeline again and check the app

- **What:** the first complete, successful deploy.
- **Why:** it confirms all the pieces work together.
- **How:** on GitHub go to **Actions**, then **Deploy to ECS**, then **Run workflow**. This time every step, including **Deploy to Amazon ECS**, should be green. That last step waits until ECS reports the new version is stable, so it can take a few minutes.
- **Then open the app:** ECS, then `test-cluster`, then `learning-ecs-service`, then the **Tasks** tab. Click the running task and copy the **Public IP** from the networking section. Visit:

  ```
  http://<public-ip>:3000/health
  ```

  You should see `Hello, World!`. **You have deployed your app.**

---

## 3. Day to day

After the setup, deploying is just:

```bash
git push origin main
```

- Watch the run on GitHub under **Actions**.
- Watch the rollout in ECS, under the service's **Deployments** tab.
- Read your app's logs in CloudWatch, under **Log groups**, then `/ecs/learning-ecs`.

Each deploy pushes an image tagged with the commit SHA, so you can always tell which commit is running.

### Costs and stopping the app

Fargate charges while a task is running, and a public IP address also has a small hourly charge. To stop paying while you aren't using it, open the service, click **Update**, and set **Desired tasks** to `0`. Set it back to `1` to start again. You can delete the service entirely when you're done learning.

---

## 4. Troubleshooting

Open the failing step in the GitHub **Actions** log first. The error message usually says what is wrong.

| Symptom | Likely cause and fix |
| --- | --- |
| **Configure AWS credentials** fails with `Could not assume role` or `Not authorized to perform sts:AssumeRoleWithWebIdentity` | The identity provider (4a) is missing, the `AWS_ROLE_ARN` secret (step 5) is wrong or empty, or the trust policy's `sub` line doesn't exactly match `repo:Shantanu143/learning-ecs:ref:refs/heads/main`. Also check you're running from the `main` branch. |
| **Build and push image** fails with `repository ... does not exist` or `denied` | The ECR repo name or region doesn't match `ECR_REPOSITORY` and `AWS_REGION` in the workflow, or the policy in 4b has the wrong account ID or repo name. |
| **Deploy to Amazon ECS** fails with `... is MISSING` | The service doesn't exist yet (do step 7), or its name isn't exactly `learning-ecs-service`. |
| **Deploy to Amazon ECS** fails with `AccessDenied` or `iam:PassRole` | The policy in 4b is missing a statement or has a typo in the role name `ecsTaskExecutionRole`. |
| Task stops with `CannotPullContainerError` | **Public IP** was off when creating the service (step 7), or `ecsTaskExecutionRole` is missing (step 3). |
| Task stops with `ResourceInitializationError` or a log group error | The log group `/ecs/learning-ecs` doesn't exist (step 2). |
| Task keeps restarting or is marked unhealthy | The app is crashing. Read the logs in CloudWatch, under `/ecs/learning-ecs`. |
| Deploy waits, then fails with a timeout | The new task never became healthy. Look at the service's **Events** tab and the stopped task's reason. |
| Browser can't reach `http://<public-ip>:3000` | The security group doesn't allow inbound TCP 3000, or you copied the IP of a task that has since been replaced. |

### A note on region

The AWS region appears in two places: `AWS_REGION` in [`deploy-ecs.yml`](.github/workflows/deploy-ecs.yml) and `awslogs-region` in [`.aws/task-definition.json`](.aws/task-definition.json). If you ever move to another region, change both.
