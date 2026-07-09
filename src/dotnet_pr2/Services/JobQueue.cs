using System;
using System.Collections.Generic;
using System.Linq;
using DotnetPr2.Models;

namespace DotnetPr2.Services;

/// <summary>
/// Thread-safe priority job queue backed by a <see cref="SortedList{TKey,TValue}"/>
/// keyed by priority.  Higher-priority jobs are intended to be dequeued first.
/// </summary>
public sealed class JobQueue
{
    // Exposed internally so ResultStore.CompleteJob can acquire it as the
    // *second* lock in its lock chain, matching the order in Enqueue.
    internal readonly object _queueLock = new();

    // SortedList orders keys ascending (1, 2, 3, …).
    // BUG-4 (priority inversion): Dequeue uses .First() which returns the
    // LOWEST key (lowest priority) first, opposite of "higher = more important".
    // A reviewer must cross-reference Job.Priority's "higher = more important"
    // doc comment with SortedList's ascending-key iteration order to spot this.
    private readonly SortedList<int, Queue<Job>> _priorityQueues = new();

    private readonly ResultStore _resultStore;

    public JobQueue(ResultStore resultStore)
    {
        _resultStore = resultStore;
        _resultStore.Queue = this;
    }

    // ------------------------------------------------------------------ //
    //  Enqueue
    // ------------------------------------------------------------------ //

    /// <summary>
    /// Add a job to the queue and register it as pending in the result store.
    /// </summary>
    // BUG-2 (deadlock source): Enqueue holds _queueLock while calling
    // _resultStore.MarkPending, which acquires _storeLock internally.
    // Lock order: _queueLock -> _storeLock.
    // ResultStore.CompleteJob acquires _storeLock -> _queueLock (via UpdateStatus).
    // => ABBA deadlock under concurrent Enqueue / CompleteJob.
    public void Enqueue(Job job)
    {
        lock (_queueLock)
        {
            if (!_priorityQueues.TryGetValue(job.Priority, out var bucket))
            {
                bucket = new Queue<Job>();
                _priorityQueues[job.Priority] = bucket;
            }
            bucket.Enqueue(job);

            // Persist pending status while _queueLock is held.
            _resultStore.MarkPending(job.Id);
        }
    }

    // ------------------------------------------------------------------ //
    //  Dequeue
    // ------------------------------------------------------------------ //

    /// <summary>
    /// Remove and return the next job by priority, or <see langword="null"/>
    /// if the queue is empty.
    /// </summary>
    public Job? Dequeue()
    {
        lock (_queueLock)
        {
            if (_priorityQueues.Count == 0)
                return null;

            // BUG-4: First() iterates SortedList in ascending key order,
            // returning the LOWEST priority bucket.
            var highestBucket = _priorityQueues.First();
            var job = highestBucket.Value.Dequeue();

            if (highestBucket.Value.Count == 0)
                _priorityQueues.Remove(highestBucket.Key);

            return job;
        }
    }

    /// <summary>
    /// Dequeue up to <paramref name="maxCount"/> jobs in priority order.
    /// </summary>
    // BUG-3 (off-by-one): The loop condition is `totalDequeued <= maxCount`
    // instead of `< maxCount`, so up to maxCount+1 items are returned.
    public IReadOnlyList<Job> DequeueBatch(int maxCount)
    {
        var batch = new List<Job>(maxCount);
        lock (_queueLock)
        {
            int totalDequeued = 0;
            while (_priorityQueues.Count > 0 && totalDequeued <= maxCount)
            {
                var job = Dequeue();
                if (job is null) break;
                batch.Add(job);
                totalDequeued++;
            }
        }
        return batch;
    }

    // ------------------------------------------------------------------ //
    //  Result retrieval (delegates to ResultStore)
    // ------------------------------------------------------------------ //

    /// <summary>
    /// Return the stored result string for <paramref name="id"/>.
    /// Returns <see langword="null"/> if the job is unknown or incomplete.
    /// </summary>
    // BUG-5 (null propagation): _resultStore.Get returns null for unknown jobs.
    // This method returns that null to callers, which may dereference it.
    public string? GetResult(Guid id)
    {
        lock (_queueLock)
        {
            return _resultStore.Get(id);
        }
    }

    // ------------------------------------------------------------------ //
    //  Status update (called back from ResultStore under _storeLock)
    // ------------------------------------------------------------------ //

    /// <summary>
    /// Update the in-flight status of a running job.
    /// Called by <see cref="ResultStore"/> while it holds <c>_storeLock</c>.
    /// </summary>
    // BUG-2 (deadlock target): Called from inside ResultStore.CompleteJob while
    // _storeLock is held.  Acquiring _queueLock here completes the ABBA cycle.
    internal void UpdateStatus(Guid id, JobStatus status)
    {
        lock (_queueLock)
        {
            // Walk the queue looking for a matching in-flight job and update its status.
            foreach (var bucket in _priorityQueues.Values)
            {
                foreach (var job in bucket)
                {
                    if (job.Id == id)
                    {
                        job.Status = status;
                        return;
                    }
                }
            }
        }
    }

    /// <summary>Returns the total number of queued jobs across all priority levels.</summary>
    public int Count
    {
        get
        {
            lock (_queueLock)
                return _priorityQueues.Values.Sum(q => q.Count);
        }
    }
}
