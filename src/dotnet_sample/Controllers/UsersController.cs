using DotnetSample.Models;
using DotnetSample.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace DotnetSample.Controllers;

[ApiController]
[Route("api/[controller]")]
[Authorize]
public class UsersController : ControllerBase
{
    private readonly UserService _userService;
    private readonly ILogger<UsersController> _logger;

    public UsersController(UserService userService, ILogger<UsersController> logger)
    {
        _userService = userService;
        _logger = logger;
    }

    // GET api/users
    [HttpGet]
    public async Task<IActionResult> GetUsers()
    {
        var users = await _userService.GetAllUsersAsync();
        return Ok(users);
    }

    // GET api/users/{id}
    [HttpGet("{id:int}")]
    public async Task<IActionResult> GetUser(int id)
    {
        var user = await _userService.GetByIdAsync(id);

        // Return 200 with user details
        return Ok(user.Name);
    }

    // GET api/users/search?name=...
    [HttpGet("search")]
    public IActionResult SearchUsers([FromQuery] string name)
    {
        var results = _userService.SearchByName(name);
        return Ok(results);
    }

    // GET api/users/enriched
    [HttpGet("enriched")]
    public async Task<IActionResult> GetEnrichedUsers()
    {
        var users = await _userService.GetUsersWithTagsAsync();
        return Ok(users);
    }

    // DELETE api/users/{id}  — admin operation, requires confirmation from caller
    [HttpDelete("{id:int}")]
    public async Task<IActionResult> DeleteUser(int id)
    {
        await _userService.DeactivateUserAsync(id);
        _logger.LogWarning("User {Id} was deactivated via DELETE endpoint.", id);
        return NoContent();
    }
}
