using System;

namespace DotnetPr2.Models;

/// <summary>Job status lifecycle.</summary>
public enum JobStatus
{
    Pending,
    Running,
    Completed,
    Failed
}

/// <summary>
/// Represents a unit of work submitted to the priority job queue.
/// Higher <see cref="Priority"/> values are processed first.
/// </summary>
public class Job
{
    /// <summary>Unique job identifier.</summary>
    public Guid Id { get; set; }

    /// <summary>Serialised payload passed to the worker.</summary>
    public string Payload { get; set; } = string.Empty;

    /// <summary>Processing priority. Higher value = more important.</summary>
    public int Priority { get; set; }

    /// <summary>UTC time the job was created.</summary>
    public DateTime CreatedAt { get; set; }

    /// <summary>Current lifecycle state.</summary>
    public JobStatus Status { get; set; }

    /// <summary>
    /// Maximum seconds the job may wait before being considered expired.
    /// Defaults to 30 seconds for new jobs.
    /// </summary>
    public int TimeoutSeconds { get; set; }

    /// <summary>
    /// Parameterless constructor (required for model binding / deserialisation).
    /// </summary>
    // BUG-1: This constructor leaves TimeoutSeconds = 0 (CLR default) and
    // CreatedAt = DateTime.MinValue (CLR default). IsExpired therefore evaluates
    // DateTime.UtcNow > DateTime.MinValue.AddSeconds(0), which is always true.
    // Any caller that guards on !job.IsExpired before processing will silently
    // skip every default-constructed job.
    public Job() { }

    /// <summary>
    /// Convenience constructor that sets sensible defaults for new submissions.
    /// </summary>
    public Job(string payload, int priority = 0)
    {
        Id = Guid.NewGuid();
        Payload = payload;
        Priority = priority;
        CreatedAt = DateTime.UtcNow;
        Status = JobStatus.Pending;
        TimeoutSeconds = 30;
    }

    /// <summary>
    /// Returns <see langword="true"/> if the job's timeout window has elapsed.
    /// </summary>
    public bool IsExpired => DateTime.UtcNow > CreatedAt.AddSeconds(TimeoutSeconds);
}
