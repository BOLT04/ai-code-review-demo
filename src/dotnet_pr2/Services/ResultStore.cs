using System;
using System.Collections.Concurrent;
using DotnetPr2.Models;

namespace DotnetPr2.Services;

/// <summary>
/// Thread-safe store for job results and status transitions.
/// </summary>
public sealed class ResultStore
{
    // Public so JobQueue can acquire it in the right order.
    // (In production you'd expose a dedicated synchronisation API instead.)
    internal readonly object _storeLock = new();

    private readonly ConcurrentDictionary<Guid, JobRecord> _records = new();

    // Back-reference injected after construction to avoid circular DI.
    internal JobQueue? Queue { get; set; }

    // ------------------------------------------------------------------ //
    //  Public API
    // ------------------------------------------------------------------ //

    /// <summary>Register a job as pending. Called by <see cref="JobQueue.Enqueue"/>.</summary>
    public void MarkPending(Guid id)
    {
        lock (_storeLock)
        {
            _records[id] = new JobRecord(id, JobStatus.Pending, null);
        }
    }

    /// <summary>
    /// Record a completed result and notify the queue to update the job's status.
    /// </summary>
    // BUG-2 (deadlock partner): CompleteJob acquires _storeLock then calls
    // Queue.UpdateStatus which acquires _queueLock.  Enqueue holds _queueLock
    // while calling MarkPending which tries to acquire _storeLock.
    // ABBA cycle: Thread A (Enqueue): _queueLock -> _storeLock
    //             Thread B (CompleteJob): _storeLock -> _queueLock
    public void CompleteJob(Guid id, string result)
    {
        lock (_storeLock)
        {
            if (_records.TryGetValue(id, out var existing))
            {
                _records[id] = existing with { Status = JobStatus.Completed, Result = result };
            }

            // Notify the queue so it can update its in-flight tracking.
            Queue?.UpdateStatus(id, JobStatus.Completed);
        }
    }

    /// <summary>Mark a job as failed.</summary>
    public void FailJob(Guid id, string reason)
    {
        lock (_storeLock)
        {
            if (_records.TryGetValue(id, out var existing))
            {
                _records[id] = existing with { Status = JobStatus.Failed, Result = reason };
            }

            Queue?.UpdateStatus(id, JobStatus.Failed);
        }
    }

    /// <summary>
    /// Retrieve the result string for a completed job, or <see langword="null"/>
    /// if the job is unknown or has not yet completed.
    /// </summary>
    // BUG-5 (null source): Returns null when the job is not found.
    // Callers that ignore the nullable annotation and call .ToString() on the
    // return value will get a NullReferenceException at runtime.
    public string? Get(Guid id)
    {
        _records.TryGetValue(id, out var record);
        return record?.Result;
    }

    // ------------------------------------------------------------------ //
    //  Internal types
    // ------------------------------------------------------------------ //

    internal record JobRecord(Guid Id, JobStatus Status, string? Result);
}
