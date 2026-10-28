package dev.cloudboard.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.List;
import java.util.TreeMap;
import org.junit.Test;

/** Checks the signer against the worked examples in the AWS documentation. */
public class SigV4Test {

    private static final String EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    @Test
    public void iamListUsersExample() throws Exception {
        // docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html (2015 example)
        String canonical = "GET\n/\nAction=ListUsers&Version=2010-05-08\n"
            + "content-type:application/x-www-form-urlencoded; charset=utf-8\nhost:iam.amazonaws.com\nx-amz-date:20150830T123600Z\n\n"
            + "content-type;host;x-amz-date\n" + EMPTY_SHA;
        assertEquals("5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
            SigV4.signature("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "us-east-1", "iam", "20150830T123600Z", canonical));
    }

    @Test
    public void s3GetObjectWithRangeExample() throws Exception {
        // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
        SigV4.Target t = SigV4.Target.build("examplebucket.s3.amazonaws.com", "s3", "us-east-1", "/test.txt", null);
        TreeMap<String, String> signed = new TreeMap<>();
        signed.put("host", t.hostHeader);
        signed.put("range", "bytes=0-9");
        signed.put("x-amz-content-sha256", EMPTY_SHA);
        signed.put("x-amz-date", "20130524T000000Z");
        String auth = SigV4.authorization("AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", t, "GET", signed, EMPTY_SHA, "20130524T000000Z");
        assertEquals("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
            + "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
            + "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41", auth);
    }

    @Test
    public void s3PresignedUrlExample() throws Exception {
        // docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
        List<String[]> q = new ArrayList<>();
        q.add(new String[] {"X-Amz-Algorithm", "AWS4-HMAC-SHA256"});
        q.add(new String[] {"X-Amz-Credential", "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request"});
        q.add(new String[] {"X-Amz-Date", "20130524T000000Z"});
        q.add(new String[] {"X-Amz-Expires", "86400"});
        q.add(new String[] {"X-Amz-SignedHeaders", "host"});
        String canonical = "GET\n/test.txt\n" + SigV4.canonicalQuery(q) + "\nhost:examplebucket.s3.amazonaws.com\n\nhost\nUNSIGNED-PAYLOAD";
        assertEquals("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
            SigV4.signature("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1", "s3", "20130524T000000Z", canonical));
    }

    @Test
    public void pathsAndQueriesAreNormalized() throws Exception {
        SigV4.Target t = SigV4.Target.parse(
            "https://b.s3.eu-west-1.amazonaws.com/photos/My%20Trip%2B2024/caf%C3%A9.jpg?list-type=2&prefix=a%20b%2F&delimiter=%2F", "eu-west-1");
        assertEquals("s3", t.service);
        assertEquals("/photos/My%20Trip%2B2024/caf%C3%A9.jpg", t.canonicalPath);
        assertEquals("delimiter=%2F&list-type=2&prefix=a%20b%2F", t.canonicalQuery);
        assertEquals("a+b", SigV4.percentDecode("a+b"));
    }

    @Test
    public void servicesComeFromTheHost() {
        assertEquals("s3", SigV4.Target.serviceFor("logs.s3.us-east-1.amazonaws.com"));
        assertEquals("s3", SigV4.Target.serviceFor("s3.us-east-1.amazonaws.com"));
        assertEquals("logs", SigV4.Target.serviceFor("logs.us-east-1.amazonaws.com"));
        assertEquals("sqs", SigV4.Target.serviceFor("sqs.ap-south-1.amazonaws.com"));
        assertEquals("monitoring", SigV4.Target.serviceFor("monitoring.eu-west-1.amazonaws.com"));
        assertEquals("sts", SigV4.Target.serviceFor("sts.amazonaws.com"));
        assertEquals("ecs", SigV4.Target.serviceFor("ecs.ap-southeast-1.amazonaws.com"));
        assertEquals("ec2", SigV4.Target.serviceFor("ec2.ap-southeast-1.amazonaws.com"));
        assertEquals("iam", SigV4.Target.serviceFor("iam.amazonaws.com"));
        assertEquals("ce", SigV4.Target.serviceFor("ce.us-east-1.amazonaws.com"));
        assertEquals("s3", SigV4.Target.serviceFor("ecs.s3.ap-southeast-1.amazonaws.com"));
    }

    @Test
    public void advancedServicesAreReadOnly() throws Exception {
        assertBlocked("ecs", "POST", "AmazonEC2ContainerServiceV20141113.UpdateService", "{}");
        assertBlocked("ecs", "POST", "AmazonEC2ContainerServiceV20141113.StopTask", "{}");
        assertBlocked("ec2", "POST", null, "Action=TerminateInstances&Version=2016-11-15");
        assertBlocked("ec2", "POST", null, "Action=StopInstances");
        assertBlocked("iam", "POST", null, "Action=CreateAccessKey");
        assertBlocked("iam", "POST", null, "Action=AttachUserPolicy");
        assertBlocked("lambda", "POST", null, "");
        assertBlocked("lambda", "PUT", null, "");
        assertBlocked("lambda", "DELETE", null, "");
        assertBlocked("dynamodb", "POST", "DynamoDB_20120810.DeleteTable", "{}");
        assertBlocked("dynamodb", "POST", "DynamoDB_20120810.PutItem", "{}");
        assertBlocked("dynamodb", "POST", "DynamoDB_20120810.Scan", "{}");
        assertBlocked("rds", "POST", null, "Action=RebootDBInstance");
        assertBlocked("sns", "POST", null, "Action=Publish");
        assertBlocked("ce", "POST", "AWSInsightsIndexService.CreateAnomalyMonitor", "{}");

        assertEquals("", ReadOnlyPolicy.enforce("lambda", "GET", null, ""));
        assertEquals("{}", ReadOnlyPolicy.enforce("ecs", "POST", "AmazonEC2ContainerServiceV20141113.DescribeServices", "{}"));
        assertEquals("Action=DescribeInstances", ReadOnlyPolicy.enforce("ec2", "POST", null, "Action=DescribeInstances"));
    }

    @Test
    public void onlyAmazonHostsOverHttps() {
        String[] bad = {
            "http://sqs.us-east-1.amazonaws.com/",
            "https://evil.example.com/",
            "https://amazonaws.com.evil.com/",
            "https://sqs.us-east-1.amazonaws.com:8443/",
            "https://kms.us-east-1.amazonaws.com/",
            "https://secretsmanager.us-east-1.amazonaws.com/",
        };
        for (String url : bad) {
            try {
                SigV4.Target.parse(url, "us-east-1");
                fail("Accepted " + url);
            } catch (SecurityException expected) {
                // ok
            } catch (Exception e) {
                fail(url + " threw " + e);
            }
        }
    }

    @Test
    public void writesAreBlocked() throws Exception {
        assertBlocked("s3", "PUT", null, "");
        assertBlocked("s3", "DELETE", null, "");
        assertBlocked("s3", "POST", null, "");
        assertBlocked("sqs", "POST", "AmazonSQS.SendMessage", "{}");
        assertBlocked("sqs", "POST", "AmazonSQS.PurgeQueue", "{}");
        assertBlocked("sqs", "POST", "AmazonSQS.DeleteMessage", "{}");
        assertBlocked("monitoring", "POST", null, "Action=PutMetricAlarm&Version=2010-08-01");
        assertBlocked("monitoring", "POST", null, "Action=DescribeAlarms&Action=DeleteAlarms");
        assertBlocked("monitoring", "POST", null, "Action=SetAlarmState");
        assertBlocked("logs", "POST", "Logs_20140328.DeleteLogGroup", "{}");
        assertBlocked("logs", "POST", "Logs_20140328.PutLogEvents", "{}");
        assertBlocked("sts", "POST", null, "Action=AssumeRole");

        assertEquals("", ReadOnlyPolicy.enforce("s3", "GET", null, ""));
        assertEquals("Action=DescribeAlarms&Version=2010-08-01",
            ReadOnlyPolicy.enforce("monitoring", "POST", null, "Action=DescribeAlarms&Version=2010-08-01"));
        assertEquals("{}", ReadOnlyPolicy.enforce("logs", "POST", "Logs_20140328.FilterLogEvents", "{}"));
    }

    private static void assertBlocked(String service, String method, String target, String body) throws Exception {
        try {
            ReadOnlyPolicy.enforce(service, method, target, body);
            fail(service + " " + method + " " + target + " " + body + " was allowed");
        } catch (SecurityException expected) {
            assertTrue(expected.getMessage().length() > 0);
        }
    }
}
