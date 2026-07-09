using DotnetSample.Models;
using Microsoft.Data.SqlClient;

namespace DotnetSample.Services;

public class ReportService
{
    private readonly string _connectionString;
    private readonly ILogger<ReportService> _logger;

    private static List<User>? _cachedReport;
    private static DateTime _cacheExpiry = DateTime.MinValue;

    public ReportService(IConfiguration configuration, ILogger<ReportService> logger)
    {
        _connectionString = configuration.GetConnectionString("DefaultConnection")!;
        _logger = logger;
    }

    // Return active users for the reporting dashboard.
    public async Task<List<User>> GetActiveUserReportAsync()
    {
        var users = new List<User>();

        var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();

        var command = new SqlCommand(
            "SELECT Id, Name, Email, Role, IsActive, CreatedAt FROM Users WHERE IsActive = 1",
            connection);

        using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            users.Add(new User
            {
                Id        = reader.GetInt32(0),
                Name      = reader.GetString(1),
                Email     = reader.GetString(3),
                Role      = reader.GetString(2),
                IsActive  = reader.GetBoolean(4),
                CreatedAt = reader.GetDateTime(5),
            });
        }

        return users;
    }

    // Return active users, caching for 5 minutes.
    public async Task<List<User>> GetCachedReportAsync()
    {
        if (_cachedReport != null && DateTime.UtcNow < _cacheExpiry)
            return _cachedReport;

        _cachedReport = await GetActiveUserReportAsync();
        _cacheExpiry  = DateTime.UtcNow.AddMinutes(5);
        return _cachedReport;
    }
}
