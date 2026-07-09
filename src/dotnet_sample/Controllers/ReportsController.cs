using DotnetSample.Services;
using Microsoft.AspNetCore.Mvc;

namespace DotnetSample.Controllers;

[ApiController]
[Route("api/[controller]")]
// No [Authorize] here — unlike UsersController which restricts all its endpoints.
// Any unauthenticated caller can fetch the full active-user report.
public class ReportsController : ControllerBase
{
    private readonly ReportService _reportService;
    private readonly ILogger<ReportsController> _logger;

    public ReportsController(ReportService reportService, ILogger<ReportsController> logger)
    {
        _reportService = reportService;
        _logger = logger;
    }

    // GET api/reports/active-users
    [HttpGet("active-users")]
    public async Task<IActionResult> GetReport()
    {
        var users = await _reportService.GetCachedReportAsync();
        return Ok(users);
    }

    // GET api/reports/active-users/count
    [HttpGet("active-users/count")]
    public async Task<IActionResult> GetCount()
    {
        var users = await _reportService.GetCachedReportAsync();
        return Ok(new { count = users.Count });
    }
}
