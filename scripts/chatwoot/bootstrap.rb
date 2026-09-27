# Runs inside the Chatwoot container (rails runner). Idempotent: creates or updates the super admin
# and the "Hamnivo" Platform App, then prints the app's access token on the last line.
email = ENV.fetch('HV_ADMIN_EMAIL')
password = ENV.fetch('HV_ADMIN_PASSWORD')

admin = User.find_or_initialize_by(email: email)
admin.name = 'Hamnivo Operator' if admin.name.blank?
admin.password = password
admin.password_confirmation = password
admin.type = 'SuperAdmin'
admin.skip_confirmation!
admin.save!

app = PlatformApp.find_or_create_by!(name: 'Hamnivo')
app.create_access_token! if app.access_token.nil?
puts "HAMNIVO_PLATFORM_TOKEN=#{app.access_token.token}"
