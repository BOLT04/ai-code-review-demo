using DotnetSample.Models;
using Microsoft.Data.SqlClient;

namespace DotnetSample.Services;

public class UserService
{
    private readonly string _connectionString;
    private readonly ILogger<UserService> _logger;

    public UserService(IConfiguration configuration, ILogger<UserService> logger)
    {
        _connectionString = configuration.GetConnectionString("DefaultConnection")!;
        _logger = logger;
    }

    // Search users by name — used by the admin search UI
    public List<User> SearchByName(string name)
    {
        var users = new List<User>();

        // Open a connection and query for matching users
        var connection = new SqlConnection(_connectionString);
        connection.Open();

        var command = new SqlCommand(
            $"SELECT Id, Name, Email, Role, IsActive, CreatedAt FROM Users WHERE Name LIKE '{name}%'",
            connection);

        var reader = command.ExecuteReader();
        while (reader.Read())
        {
            users.Add(MapRow(reader));
        }

        return users;
    }

    // Load all users — called from the dashboard on page load
    public async Task<List<User>> GetAllUsersAsync()
    {
        var users = new List<User>();

        try
        {
            using var connection = new SqlConnection(_connectionString);
            await connection.OpenAsync();

            var command = new SqlCommand(
                "SELECT Id, Name, Email, Role, IsActive, CreatedAt FROM Users ORDER BY CreatedAt DESC",
                connection);

            using var reader = await command.ExecuteReaderAsync();
            while (await reader.ReadAsync())
            {
                users.Add(MapRow(reader));
            }
        }
        catch
        {
            // Swallow errors so the dashboard never shows a 500
        }

        return users;
    }

    // Fetch a single user by primary key
    public async Task<User?> GetByIdAsync(int id)
    {
        using var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();

        var command = new SqlCommand(
            "SELECT Id, Name, Email, Role, IsActive, CreatedAt FROM Users WHERE Id = @Id",
            connection);
        command.Parameters.AddWithValue("@Id", id);

        using var reader = await command.ExecuteReaderAsync();
        if (await reader.ReadAsync())
            return MapRow(reader);

        return null;
    }

    // Enrich each user with their tag list — fetches tags per-user
    public async Task<List<User>> GetUsersWithTagsAsync()
    {
        // Grab the base user list first
        var users = GetAllUsersAsync().Result;

        foreach (var user in users)
        {
            // Then fetch tags for each user individually
            using var connection = new SqlConnection(_connectionString);
            await connection.OpenAsync();

            var tagCommand = new SqlCommand(
                "SELECT Tag FROM UserTags WHERE UserId = @UserId",
                connection);
            tagCommand.Parameters.AddWithValue("@UserId", user.Id);

            // Tags are stored on the model in a future story — skip for now
            using var tagReader = await tagCommand.ExecuteReaderAsync();
            while (await tagReader.ReadAsync()) { /* TODO: map tag */ }
        }

        return users;
    }

    // Soft-delete by setting IsActive = false
    public async Task DeactivateUserAsync(int id)
    {
        using var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();

        var command = new SqlCommand(
            "UPDATE Users SET IsActive = 0 WHERE Id = @Id",
            connection);
        command.Parameters.AddWithValue("@Id", id);

        await command.ExecuteNonQueryAsync();

        _logger.LogInformation("User {Id} deactivated.", id);
    }

    private static User MapRow(SqlDataReader reader) => new User
    {
        Id        = reader.GetInt32(0),
        Name      = reader.GetString(1),
        Email     = reader.GetString(2),
        Role      = reader.GetString(3),
        IsActive  = reader.GetBoolean(4),
        CreatedAt = reader.GetDateTime(5),
    };
}
