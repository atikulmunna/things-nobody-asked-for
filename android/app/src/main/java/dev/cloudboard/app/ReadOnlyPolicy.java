package dev.cloudboard.app;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONObject;

/**
 * The only AWS calls cloudBoard may make. Anything not listed here is refused before it is
 * signed, so the app cannot change your account even if the web layer asked it to.
 */
final class ReadOnlyPolicy {

    private ReadOnlyPolicy() {}

    static final Set<String> STS = setOf("GetCallerIdentity");
    static final Set<String> CLOUDWATCH = setOf(
        "DescribeAlarms", "DescribeAlarmHistory", "DescribeAlarmsForMetric", "ListMetrics", "GetMetricData");
    static final Set<String> SQS = setOf(
        "ListQueues", "GetQueueAttributes", "GetQueueUrl", "ListQueueTags", "ListDeadLetterSourceQueues", "ReceiveMessage");
    static final Set<String> LOGS = setOf(
        "DescribeLogGroups", "DescribeLogStreams", "GetLogEvents", "FilterLogEvents");

    // Advanced mode services.
    static final Set<String> ECS = setOf(
        "ListClusters", "DescribeClusters", "ListServices", "DescribeServices", "ListTasks", "DescribeTasks", "DescribeTaskDefinition");
    static final Set<String> EC2 = setOf("DescribeInstances");
    static final Set<String> IAM = setOf(
        "GetUser", "ListGroupsForUser", "ListAttachedUserPolicies", "ListUserPolicies", "GetUserPolicy",
        "ListAttachedGroupPolicies", "ListGroupPolicies", "GetGroupPolicy",
        "ListAttachedRolePolicies", "ListRolePolicies", "GetRolePolicy", "GetPolicy", "GetPolicyVersion");
    static final Set<String> COST = setOf("GetCostAndUsage");
    static final Set<String> DYNAMODB = setOf("ListTables", "DescribeTable");
    static final Set<String> RDS = setOf("DescribeDBInstances", "DescribeDBClusters");
    static final Set<String> SNS = setOf("ListTopics", "GetTopicAttributes", "ListSubscriptionsByTopic");

    /** Returns the body to send (possibly rewritten), or throws SecurityException. */
    static String enforce(String service, String method, String target, String body) throws Exception {
        switch (service) {
            case "s3":
                if (!"GET".equals(method) && !"HEAD".equals(method)) {
                    throw new SecurityException("cloudBoard is read-only: S3 " + method + " is blocked.");
                }
                return "";
            case "sts":
                requirePost(method);
                requireAction(formAction(body), STS, "STS");
                return body;
            case "monitoring":
                requirePost(method);
                requireAction(formAction(body), CLOUDWATCH, "CloudWatch");
                return body;
            case "sqs": {
                requirePost(method);
                String action = targetAction(target, "AmazonSQS.");
                requireAction(action, SQS, "SQS");
                if ("ReceiveMessage".equals(action)) {
                    // Peeking must leave messages visible to their real consumers.
                    JSONObject json = new JSONObject(body.isEmpty() ? "{}" : body);
                    json.put("VisibilityTimeout", 0);
                    return json.toString();
                }
                return body;
            }
            case "logs":
                requirePost(method);
                requireAction(targetAction(target, "Logs_20140328."), LOGS, "CloudWatch Logs");
                return body;
            case "ecs":
                requirePost(method);
                requireAction(targetAction(target, "AmazonEC2ContainerServiceV20141113."), ECS, "ECS");
                return body;
            case "ec2":
                requirePost(method);
                requireAction(formAction(body), EC2, "EC2");
                return body;
            case "iam":
                requirePost(method);
                requireAction(formAction(body), IAM, "IAM");
                return body;
            case "lambda":
                // Lambda is a REST API: every GET is a read, everything else changes something.
                if (!"GET".equals(method)) throw new SecurityException("cloudBoard is read-only: Lambda " + method + " is blocked.");
                return "";
            case "ce":
                requirePost(method);
                requireAction(targetAction(target, "AWSInsightsIndexService."), COST, "Cost Explorer");
                return body;
            case "dynamodb":
                requirePost(method);
                requireAction(targetAction(target, "DynamoDB_20120810."), DYNAMODB, "DynamoDB");
                return body;
            case "rds":
                requirePost(method);
                requireAction(formAction(body), RDS, "RDS");
                return body;
            case "sns":
                requirePost(method);
                requireAction(formAction(body), SNS, "SNS");
                return body;
            default:
                throw new SecurityException("cloudBoard does not talk to the " + service + " service.");
        }
    }

    private static void requirePost(String method) {
        if (!"POST".equals(method)) throw new SecurityException("Only POST is used for this service.");
    }

    private static void requireAction(String action, Set<String> allowed, String label) {
        if (action == null || !allowed.contains(action)) {
            throw new SecurityException("cloudBoard is read-only: " + label + " " + (action == null ? "request" : action) + " is blocked.");
        }
    }

    static String targetAction(String target, String prefix) {
        if (target == null || !target.startsWith(prefix)) return null;
        return target.substring(prefix.length());
    }

    /** The Action of a form-encoded query-protocol body; null if missing or repeated. */
    static String formAction(String body) {
        String action = null;
        for (String pair : body.split("&")) {
            int eq = pair.indexOf('=');
            String k = SigV4.percentDecode(eq < 0 ? pair : pair.substring(0, eq));
            if (!"Action".equals(k)) continue;
            if (action != null) return null;
            action = SigV4.percentDecode(eq < 0 ? "" : pair.substring(eq + 1));
        }
        return action;
    }

    private static Set<String> setOf(String... items) {
        return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(items)));
    }
}
