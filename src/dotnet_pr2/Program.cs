using DotnetPr2.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// Register queue infrastructure as singletons so the in-process queue
// survives across requests.  ResultStore is constructed first because
// JobQueue takes it as a constructor parameter; the back-reference
// (ResultStore.Queue) is wired by JobQueue's own constructor.
builder.Services.AddSingleton<ResultStore>();
builder.Services.AddSingleton<JobQueue>();

builder.Services.AddCors(options =>
{
    options.AddPolicy("LocalDev", policy =>
        policy.WithOrigins(
                builder.Configuration["Cors:AllowedOrigin"] ?? "http://localhost:3000")
              .AllowAnyMethod()
              .AllowAnyHeader());
});

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseCors("LocalDev");
app.MapControllers();

app.Run();
