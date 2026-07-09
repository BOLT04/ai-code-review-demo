using System;
using Microsoft.AspNetCore.Mvc;
using DotnetPr2.Models;
using DotnetPr2.Services;

namespace DotnetPr2.Controllers;

/// <summary>
/// Manages job submission, result retrieval, and cancellation.
/// </summary>
[ApiController]
[Route("jobs")]
public sealed class JobController : ControllerBase
{
    private readonly JobQueue _queue;

    public JobController(JobQueue queue)
    {
        _queue = queue;
    }

    // ------------------------------------------------------------------ //
    //  POST /jobs
    // ------------------------------------------------------------------ //

    /// <summary>Submit a new job to the priority queue.</summary>
    /// <param name="request">Job submission payload and priority.</param>
    [HttpPost]
    [ProducesResponseType(typeof(JobSubmitResponse), 202)]
    [ProducesResponseType(400)]
    public IActionResult Submit([FromBody] JobSubmitRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Payload))
            return BadRequest("Payload must not be empty.");

        var job = new Job(request.Payload, request.Priority);
        _queue.Enqueue(job);

        return Accepted(new JobSubmitResponse(job.Id, job.CreatedAt));
    }

    // ------------------------------------------------------------------ //
    //  GET /jobs/{id}/result
    // ------------------------------------------------------------------ //

    /// <summary>Retrieve the result of a completed job.</summary>
    /// <param name="id">Job identifier returned by POST /jobs.</param>
    [HttpGet("{id:guid}/result")]
    [ProducesResponseType(typeof(string), 200)]
    [ProducesResponseType(404)]
    public IActionResult GetResult(Guid id)
    {
        var result = _queue.GetResult(id);

        // BUG-5 (null dereference, cross-file): _queue.GetResult delegates to
        // ResultStore.Get, which returns null when the job is not found.
        // GetResult propagates that null here, and result.ToString() throws
        // NullReferenceException instead of returning 404.
        // Tracing path: JobController.GetResult -> JobQueue.GetResult
        //               -> ResultStore.Get -> null -> .ToString() crash.
        return Ok(result!.ToString());
    }

    // ------------------------------------------------------------------ //
    //  DELETE /jobs/{id}
    // ------------------------------------------------------------------ //

    /// <summary>Cancel a pending job.</summary>
    /// <param name="id">Job identifier to cancel.</param>
    [HttpDelete("{id:guid}")]
    [ProducesResponseType(204)]
    [ProducesResponseType(404)]
    public IActionResult Cancel(Guid id)
    {
        // Cancellation is best-effort: if the job has already been picked up
        // by a worker it cannot be recalled.
        return NoContent();
    }
}

// ------------------------------------------------------------------ //
//  Request / response DTOs
// ------------------------------------------------------------------ //

/// <summary>Request body for job submission.</summary>
public sealed record JobSubmitRequest(string Payload, int Priority = 0);

/// <summary>Response body confirming job acceptance.</summary>
public sealed record JobSubmitResponse(Guid JobId, DateTime QueuedAt);
