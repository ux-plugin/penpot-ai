import { useState, useEffect } from 'react';
import { Button } from '@ui/button';
import { Input } from '@ui/input';
import { Label } from '@ui/label';
import { Edit, Save, XCircle } from 'lucide-react';
import { useUserSettingsStore } from '@/plugin-ui/stores/useUserSettingsStore.ts';

function ProfileSection() {
  const { name, email, setName, setEmail } = useUserSettingsStore();
  const [isEditing, setIsEditing] = useState(false);
  const [localName, setLocalName] = useState(name || '');
  const [localEmail, setLocalEmail] = useState(email || '');

  // Update local state when global store values change
  useEffect(() => {
    setLocalName(name || '');
    setLocalEmail(email || '');
  }, [name, email]);

  const handleEditClick = () => {
    setIsEditing(true);
  };

  const handleSaveClick = () => {
    setName(localName);
    setEmail(localEmail);
    setIsEditing(false);
  };

  const handleCancelClick = () => {
    setLocalName(name || '');
    setLocalEmail(email || '');
    setIsEditing(false);
  };

  return (
    <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-md font-semibold">Profile</h2>
        {isEditing ? (
          <div className="flex space-x-2">
            <Button variant="ghost" size="icon" className="text-gray-800" onClick={handleSaveClick}>
              <Save className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="text-gray-800" onClick={handleCancelClick}>
              <XCircle className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="icon" className="text-gray-800" onClick={handleEditClick}>
            <Edit className="h-4 w-4" />
          </Button>
        )}
      </div>
      <p className="text-sm text-gray-500 mb-4">Your account information</p>
      <div className="space-y-4">
        <div>
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={localName}
            onChange={(e) => setLocalName(e.target.value)}
            className={`mt-1 ${isEditing 
              ? 'bg-white border-blue-300 text-black' 
              : 'bg-gray-100 border-gray-200 text-gray-700 cursor-not-allowed'}`}
            readOnly={!isEditing}
          />
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={localEmail}
            onChange={(e) => setLocalEmail(e.target.value)}
            className={`mt-1 ${isEditing 
              ? 'bg-white border-blue-300 text-black' 
              : 'bg-gray-100 border-gray-200 text-gray-700 cursor-not-allowed'}`}
            readOnly={!isEditing}
          />
        </div>
      </div>
    </div>
  );
}

export default ProfileSection;
